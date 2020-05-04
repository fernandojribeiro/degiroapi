/**
 * Returns given string with the first letter in lower case
 *
 * @param {string} str
 * @return {string}
 */
module.exports.lcFirst = str => str.charAt(0).toLowerCase() + str.slice(1);

/**
 * Returns given http headers object to name-value json object
 *
 * @param {string} headers
 * @return {string} json
 */
module.exports.headerToJSON = headers => {
    let json = {};
    for (let [key, value] of headers) {
        json[key] = value;
    }
    return json;
}