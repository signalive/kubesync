'use strict';

const _ = require('lodash');
const rp = require('request-promise');


/**
 * Gets all pods.
 * @return {Promise.<Array>}
 */
function getPods() {
    return rp({
            method: 'GET',
            url: `${global.K8S_API_ROOT}/api/v1/pods`,
            json: true
        })
        .then(result => result.items);
}


/**
 * Gets all replication controllers.
 * @return {Promise.<Array>}
 */
function getRCs() {
    return rp({
            method: 'GET',
            url: `${global.K8S_API_ROOT}/api/v1/replicationcontrollers`,
            json: true
        })
        .then(result => result.items);
}


/**
 * Creates a replication controller.
 * @param {Object} config
 * @return {Promise.<Object>} Created rc
 */
function createRC(config) {
    const namespace = config.metadata.namespace || 'default';

    return rp({
        method: 'POST',
        url: `${global.K8S_API_ROOT}/api/v1/namespaces/${namespace}/replicationcontrollers`,
        json: true,
        body: config
    });
}


/**
 * Updates a replication controller. At first we forcely scale the rc
 * down to 0, then update with original value. Therefore, all the pods
 * will be restarted.
 * @param {Object} config
 * @return {Promise.<Object>} Updated rc
 */
function updateRC(config) {
    return scaleRC(config, 0)
        .then(_ => updateRC_(config));
}


/**
 * Core rc update method.
 * @param {Object} config
 * @return {Promise.<Object>} Updated rc
 */
function updateRC_(config) {
    const namespace = config.metadata.namespace || 'default';
    const name = config.metadata.name;

    return rp({
        method: 'PUT',
        url: `${global.K8S_API_ROOT}/api/v1/namespaces/${namespace}/replicationcontrollers/${name}`,
        json: true,
        body: config
    });
}


/**
 * Scales a replication controller. It actually updates configration of the rc.
 * Because scale is not supported by api.
 * @param {Object} config
 * @param {number} count Desired replicas count
 * @return {Promise.<Object>} Updated rc
 */
function scaleRC(config, count) {
    const configCopy = _.cloneDeep(config);
    configCopy.spec.replicas = count;
    return updateRC_(configCopy);
}


/**
 * Deletes a replication controller. Before the deletion, we scale it down to 0.
 * Because if we just delete rc, all the related pods are remaining.
 * @param {Object} config
 * @return {Promise.<Object>} Deleted rc
 */
function deleteRC(config) {
    const namespace = config.metadata.namespace || 'default';
    const name = config.metadata.name;

    return scaleRC(config, 0)
        .then(_ => rp({
            method: 'DELETE',
            url: `${global.K8S_API_ROOT}/api/v1/namespaces/${namespace}/replicationcontrollers/${name}`,
            json: true
        }));
}


/**
 * Gets all the services.
 * @return {Promise.<Array>}
 */
function getServices() {
    return rp({
            method: 'GET',
            url: `${global.K8S_API_ROOT}/api/v1/services`,
            json: true
        })
        .then(result => result.items);
}


/**
 * Creates a service.
 * @param {Object} config
 * @return {Promise.<Object>} Created service.
 */
function createService(config) {
    const namespace = config.metadata.namespace || 'default';

    return rp({
        method: 'POST',
        url: `${global.K8S_API_ROOT}/api/v1/namespaces/${namespace}/services`,
        json: true,
        body: config
    });
}


/**
 * Updates service. Simple update is not working for most changes
 * (they're immutable by default), we use delete/create flow.
 * @param {Object} config
 * @return {Promise.<Object>} Created service.
 */
function updateService(config) {
    return deleteService(config)
        .then(_ => createService(config));
}


/**
 * Deletes a service.
 * @param {Object} config
 * @return {Promise.<Object>} Deleted service.
 */
function deleteService(config) {
    const namespace = config.metadata.namespace || 'default';
    const name = config.metadata.name;

    return rp({
        method: 'DELETE',
        url: `${global.K8S_API_ROOT}/api/v1/namespaces/${namespace}/services/${name}`,
        json: true
    });
}


module.exports.getPods = getPods;
module.exports.getRCs = getRCs;
module.exports.createRC = createRC;
module.exports.updateRC = updateRC;
module.exports.deleteRC = deleteRC;
module.exports.scaleRC = scaleRC;
module.exports.getServices = getServices;
module.exports.createService = createService;
module.exports.updateService = updateService;
module.exports.deleteService = deleteService;
