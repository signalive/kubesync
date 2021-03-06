#!/usr/bin/env node
'use strict';

const yaml = require('js-yaml');
const fsp = require('fs-promise');
const _ = require('lodash');
const rp = require('request-promise');
const program = require('commander');
const clor = require('clor');
const pad = require('pad');
const k8s = require('./k8s');


global.K8S_API_ROOT = process.env.K8S_API_ROOT || 'http://127.0.0.1:8080';
global.ENSURE_RETRY_INTERVAL = process.env.ENSURE_RETRY_INTERVAL || 5000;
global.ENSURE_MAX_RETRY_COUNT = process.env.ENSURE_MAX_RETRY_COUNT || 60;
let ensureRetryCount = 0;


/**
 * Kubernetes operations.
 *
 * CREATE => There is no remote resource with same name and type, creates a new resource.
 * UPDATE => There is a remote resource with same name and type, updates a resource.
 * NONE => Remote resource and local one is the same, does nothing.
 *
 * @enum {String}
 */
const Strategies = {
    CREATE: 'create',
    UPDATE: 'update',
    NOOP: 'noop'
};


/**
 * Strategy to console color mapping.
 * @enum {String}
 */
const strategyColorMap = {
    'create': 'green',
    'update': 'yellow',
    'noop': 'dim'
};


/**
 * Start commander.
 */
program
    .version(require('../package.json').version)
    .usage('<folder> [options]')
    .option('-d, --dry-run', 'run the script without any changes on remote k8s for test purposes')
    .option('-e, --ensure-all-running', 'watch related pods after execution and wait until they\'re in `running` state')
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
    console.log(clor.bold('=> Fetching remote RCs and services from k8s...').string);
    console.log(clor.dim(`Kubernetes API: ${global.K8S_API_ROOT}`).string);

    const plannedStrategies = {
        rc: [],
        svc: []
    };

    let results = [];
    let configs = null;

    Promise.all([
            k8s.getRCs(),
            k8s.getServices()
        ])
        .then((results_) => {
            results = results_;

            console.log(clor.dim(`Fetched ${results[0].length} replication controllers and ${results[1].length} services`).string);
            return readConfigFiles(folder);
        })
        .then((configs_) => {
            configs = configs_;
            console.log(`\n${clor.bold('=> Determining strategies...')}`);

            const fetchedRCs = _.keyBy(results[0], 'metadata.name');
            const fetchedServices = _.keyBy(results[1], 'metadata.name');

            console.log(
                clor.dim(pad('Name', 40, ' ')) +
                clor.dim(pad('Type', 30, ' ')) +
                clor.dim(pad('Strategy', 10, ' '))
            );

            console.log(
                clor.dim(pad(40, ' ', '-')) +
                clor.dim(pad(30, ' ', '-')) +
                clor.dim(pad(10, ' ', '-'))
            );

            if (_.isArray(configs.ReplicationController)) {
                configs.ReplicationController.forEach((rc) => {
                    const strategy = compareRC(rc, fetchedRCs[rc.metadata.name]);
                    plannedStrategies.rc.push(strategy);

                    const color = strategyColorMap[strategy.type];
                    console.log(
                        clor[color](pad(rc.metadata.name, 40, ' ')) +
                        clor[color](pad('ReplicationController', 30, ' ')) +
                        clor[color](pad(strategy.type, 10, ' '))
                    );
                });
            }

            if (_.isArray(configs.Service)) {
                configs.Service.forEach((svc) => {
                    const strategy = compareService(svc, fetchedServices[svc.metadata.name]);
                    plannedStrategies.rc.push(strategy);

                    const color = strategyColorMap[strategy.type];
                    console.log(
                        clor[color](pad(svc.metadata.name, 40, ' ')) +
                        clor[color](pad('Service', 30, ' ')) +
                        clor[color](pad(strategy.type, 10, ' '))
                    );
                });
            }
        })
        .then(() => {
            console.log('');

            if (program.dryRun)
                return console.log(clor.bold('=> No execution due to dry-run, skipping...').string);

            const tasks = [].concat(
                plannedStrategies.rc
                    .filter(strategy => strategy.type != Strategies.NOOP)
                    .map(strategy => performRCStrategy(strategy)),
                plannedStrategies.svc
                    .filter(strategy => strategy.type != Strategies.NOOP)
                    .map(strategy => performServiceStrategy(strategy))
            );

            if (tasks.length == 0)
                return console.log(clor.bold('=> No strategy to execute, skipping...').string);

            console.log(clor.bold('=> Executing plans...').string);
            return Promise.all(tasks);
        })
        .then(() => {
            if (!program.ensureAllRunning)
                return;

            console.log('\n' + clor.bold('=> Ensuring all the related pods are running state...'));
            return ensureAllRunning(configs);
        })
        .then(() => {
            console.log('\n' + clor.bold('=> Done'));
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
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
    console.log(`\n${clor.bold('=> Scanning for configuration files...')}`);

    return fsp
        .walk(_.isString(opt_path) ? opt_path : '.')
        .then(results => results.filter(result => result.path.match(/(\.json|\.yaml)$/)))
        .then(results => results.map((result) => {
            console.log(`${clor.dim(result.path)}`);

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
        return { type: Strategies.NOOP, config: readConfig };

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
        return { type: Strategies.NOOP, config: readConfig };

    return { type: Strategies.UPDATE, config: readConfig };
}


/**
 * Performs provided strategy for a replication controller.
 * @param {{type, config}} strategy
 * @return {Promise}
 */
function performRCStrategy(strategy) {
    if (strategy.type == Strategies.CREATE) {
        return k8s
            .createRC(strategy.config)
            .then((result) => {
                console.log(clor.green(`✓ ${strategy.config.metadata.name}`).string);
            })
            .catch((err) => {
                console.log(clor.red(`✕ ${strategy.config.metadata.name}`).string);
                console.log(err);
            });
    }

    if (strategy.type == Strategies.UPDATE) {
        return k8s
                .updateRC(strategy.config)
                .then((result) => {
                    console.log(clor.green(`✓ ${strategy.config.metadata.name}`).string);
                })
                .catch((err) => {
                    console.log(clor.red(`✕ ${strategy.config.metadata.name}`).string);
                    console.log(err);
                });
    }

    return Promise.resolve();
}


/**
 * Performs provided strategy for a service.
 * @param {{type, config}} strategy
 * @return {Promise}
 */
function performServiceStrategy(strategy) {
    if (strategy.type == Strategies.CREATE) {
        return k8s
            .createService(strategy.config)
            .then((result) => {
                console.log(clor.green(`✓ ${strategy.config.metadata.name}`).string);
            })
            .catch((err) => {
                console.log(clor.red(`✕ ${strategy.config.metadata.name}`).string);
                console.log(err);
            });
    }

    if (strategy.type == Strategies.UPDATE) {
        return k8s
                .updateService(strategy.config)
                .then((result) => {
                    console.log(clor.green(`✓ ${strategy.config.metadata.name}`).string);
                })
                .catch((err) => {
                    console.log(clor.red(`✕ ${strategy.config.metadata.name}`).string);
                    console.log(err);
                });
    }

    return Promise.resolve();
}


/**
 * Ensures all the pods are in `running` state.
 * @param {Object} configs Read configurations
 * @return {Promise}
 */
function ensureAllRunning(configs) {
    if (!_.isObject(configs))
        return Promise.reject(new Error(`No configuration provided, could not ensure`));

    if (!_.isArray(configs.ReplicationController) || configs.ReplicationController.length == 0)
        return Promise.reject(new Error(`There is no read rc configuration, could not ensure`));

    if (ensureRetryCount == global.ENSURE_MAX_RETRY_COUNT)
        return Promise.reject(new Error(`Ensure failed, max retry count reached`));

    ensureRetryCount++;

    return k8s
        .getPods()
        .then((pods) => {
            const podCountByRC = {};
            let totalDesiredCount = 0;
            let totalRunningCount = 0;

            configs.ReplicationController.forEach((rc) => {
                const matches = pods.filter((pod) => {
                    if (pod.metadata.deletionTimestamp)
                        return false;

                    if (pod.status.phase != 'Running')
                        return false;

                    return _.isMatch(pod.metadata.labels, rc.spec.template.metadata.labels);
                });

                totalDesiredCount += rc.spec.replicas;
                totalRunningCount += matches.length;

                podCountByRC[rc.metadata.name] = {
                    running: matches.length,
                    desired: rc.spec.replicas
                };
            });

            // _.forEach(podCountByRC, (count, name) => {
            //     console.log(clor.dim(`${name}: ${count.running}/${count.desired}`).string);
            // });

            console.log(clor.dim(`Running: ${totalRunningCount} / Desired: ${totalDesiredCount}`).string);

            if (totalRunningCount == totalDesiredCount)
                return;

            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve(ensureAllRunning(configs));
                }, global.ENSURE_RETRY_INTERVAL);
            });
        });
}
