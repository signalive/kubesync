#!/usr/bin/env node
'use strict';

const yaml = require('js-yaml');
const fsp = require('fs-promise');
const _ = require('lodash');
const rp = require('request-promise');
const program = require('commander');


process.env.K8S_API_ROOT = 'http://127.0.0.1:8080';
const k8s = require('./k8s');


/**
 * Kubernetes operations.
 *
 * CREATE => There is no remote resource with same name and type, creates a new resource.
 * UPDATE => There is a remote resource with same name and type, updates a resource.
 * NONE => Remote resource and local one is the same, does nothing.
 *
 * @type {Object}
 */
const Strategies = {
    CREATE: 'create',
    UPDATE: 'update',
    NONE: 'none'
};


/**
 * Start commander.
 */
program
    .version(require('../package.json').version)
    .usage('<folder> [options]')
    .option('-d, --dry-run', 'run the script without any changes on remote k8s for test purposes')
    .action((folder) => {
        init(folder);
    })
    .parse(process.argv);

if (!program.args.length)
    return program.help();


/**
 * Go baby, go.
 */
function init(folder) {
    console.log(`Fetching remote RCs and services from k8s...`);
    return Promise.all([
            k8s.getRCs(),
            k8s.getServices(),
            readConfigFiles(folder)
        ])
        .then((results) => {
            const fetchedRCs = _.keyBy(results[0], 'metadata.name');
            const fetchedServices = _.keyBy(results[1], 'metadata.name');
            const configs = results[2];
            const tasks = [];

            if (_.isArray(configs.ReplicationController)) {
                configs.ReplicationController.forEach((rc) => {
                    const strategy = compareRC(rc, fetchedRCs[rc.metadata.name]);
                    const task = performRCStrategy(strategy);
                    tasks.push(task);
                });
            }

            if (_.isArray(configs.Service)) {
                configs.Service.forEach((svc) => {
                    const strategy = compareService(svc, fetchedServices[svc.metadata.name]);
                    const task = performServiceStrategy(strategy);
                    tasks.push(task);
                });
            }

            return Promise.all(tasks);
        })
        .catch(console.error.bind(console));
}


/**
 * Reads all the json and yaml files in provided path (optional `./` current folder).
 * Then converts it json object, lastly groups by existing resource types.
 *
 * Sample output:
 * {
 *      'ReplicationController': [...],
 *      'Service': [...],
 *      'Secret': [...]
 * }
 *
 * @param {string=} opt_path
 * @return {Promise.<Object>}
 */
function readConfigFiles(opt_path) {
    console.log(`Scanning for configuration files...`);

    return fsp
        .walk(_.isString(opt_path) ? opt_path : '.')
        .then(results => results.filter(result => result.path.match(/(\.json|\.yaml)$/)))
        .then(results => results.map((result) => {
            console.log(`    > Reading ${result.path}`);

            return fsp
                .readFile(result.path, 'utf8')
                .then((raw) => {
                    let json;

                    try {
                        json = JSON.parse(raw);
                    } catch(err) {

                    }

                    if (!json) {
                        try {
                            json = yaml.safeLoad(raw);
                        } catch(err) {

                        }
                    }

                    if (!json)
                        throw new Error(`Parse error: ${result.path}`);

                    return json;
                })
                .then((config) => {
                    if (!_.isObject(config))
                        throw new Error(`Broken config: ${result.path}`);

                    if (!_.isString(config.kind))
                        throw new Error(`Missing kind config: ${result.path}`);

                    return config;
                })
        }))
        .then(promises => Promise.all(promises))
        .then(configs => _.groupBy(configs, 'kind'));
}


/**
 * Compares local rc config file with remote one. It returns a strategy object.
 * A strategy type can be create, update and none (look above).
 *
 * Fields that will be checked:
 * `spec.template.spec.containers[].image`
 * `spec.template.spec.containers[].command`
 * `spec.template.spec.containers[].env`
 *
 * @param {Object} readConfig Local config file
 * @param {Object=} opt_remoteConfig Remote config file
 * @return {{type, config}}}
 */
function compareRC(readConfig, opt_remoteConfig) {
    if (!opt_remoteConfig)
        return { type: Strategies.CREATE, config: readConfig };

    const containerFields = ['image', 'command', 'env'];
    const newContainers = readConfig.spec.template.spec.containers.map(c => _.pick(c, containerFields));
    const currentContainers = opt_remoteConfig.spec.template.spec.containers.map(c => _.pick(c, containerFields));

    if (_.isEqual(newContainers, currentContainers))
        return { type: Strategies.NONE, config: readConfig };

    return { type: Strategies.UPDATE, config: readConfig };
}


/**
 * Compares local service config file with remote one. It returns a strategy object.
 * A strategy type can be create, update and none (look above).
 *
 * Fields that will be checked:
 * `spec.ports[].port`
 * `spec.ports[].targetPort`
 * `spec.selector.name`
 *
 * @param {Object} readConfig Local config file
 * @param {Object=} opt_remoteConfig Remote config file
 * @return {{type, config}}}
 */
function compareService(readConfig, opt_remoteConfig) {
    if (!opt_remoteConfig)
        return { type: Strategies.CREATE, config: readConfig };

    const portFields = ['port', 'targetPort'];
    const newPorts = readConfig.spec.ports.map(c => _.pick(c, portFields));
    const currentPorts = opt_remoteConfig.spec.ports.map(c => _.pick(c, portFields));

    if (_.isEqual(newPorts, currentPorts) &&
        (readConfig.spec.selector.name == opt_remoteConfig.spec.selector.name))
        return { type: Strategies.NONE, config: readConfig };

    return { type: Strategies.UPDATE, config: readConfig };
}


/**
 * Performs provided strategy for a replication controller.
 * @param {{type, config}} strategy
 * @return {Promise}
 */
function performRCStrategy(strategy) {
    if (strategy.type == Strategies.CREATE) {
        console.log(`[rc] ${strategy.config.metadata.name} - CREATE`);

        if (program.dryRun)
            return Promise.resolve();

        return k8s
            .createRC(strategy.config)
            .then((result) => {
                console.log(`DONE - [rc] ${strategy.config.metadata.name}`);
            })
            .catch((err) => {
                console.log(`ERROR - [rc] ${strategy.config.metadata.name}`, err);
            });
    }

    if (strategy.type == Strategies.UPDATE) {
        console.log(`[rc] ${strategy.config.metadata.name} - UPDATE`);

        if (program.dryRun)
            return Promise.resolve();

        return k8s
                .updateRC(strategy.config)
                .then((result) => {
                    console.log(`DONE - [rc] ${strategy.config.metadata.name}`);
                })
                .catch((err) => {
                    console.log(`ERROR - [rc] ${strategy.config.metadata.name}`, err);
                });
    }

    console.log(`[rc] ${strategy.config.metadata.name} - no change`);
    return Promise.resolve();
}


/**
 * Performs provided strategy for a service.
 * @param {{type, config}} strategy
 * @return {Promise}
 */
function performServiceStrategy(strategy) {
    if (strategy.type == Strategies.CREATE) {
        console.log(`[svc] ${strategy.config.metadata.name} - CREATE`);

        if (program.dryRun)
            return Promise.resolve();

        return k8s
            .createService(strategy.config)
            .then((result) => {
                console.log(`DONE - [svc] ${strategy.config.metadata.name}`);
            })
            .catch((err) => {
                console.log(`ERROR - [svc] ${strategy.config.metadata.name}`, err);
            });
    }

    if (strategy.type == Strategies.UPDATE) {
        console.log(`[svc] ${strategy.config.metadata.name} - UPDATE`);

        if (program.dryRun)
            return Promise.resolve();

        return k8s
                .updateService(strategy.config)
                .then((result) => {
                    console.log(`DONE - [svc] ${strategy.config.metadata.name}`);
                })
                .catch((err) => {
                    console.log(`ERROR - [svc] ${strategy.config.metadata.name}`, err);
                });
    }

    console.log(`[svc] ${strategy.config.metadata.name} - no change`);
    return Promise.resolve();
}
