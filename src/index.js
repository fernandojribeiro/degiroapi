const fetch = require('node-fetch');
const querystring = require('querystring');
const parseCookies = require('cookie').parse;
const {Actions, OrderTypes, TimeTypes, ProductTypes, Sort} = require('./constants');
const omitBy = require('lodash/omitBy');
const omit = require('lodash/omit');
const isNil = require('lodash/isNil');
const fromPairs = require('lodash/fromPairs');
const {lcFirst} = require('./utils');

const BASE_TRADER_URL = 'https://trader.degiro.nl';

const create = ({
    username = process.env.DEGIRO_USER,
    password = process.env.DEGIRO_PASS,
    oneTimePassword = process.env.DEGIRO_ONE_TIME_PASS,
    sessionId = process.env.DEGIRO_SID,
    account = +process.env.DEGIRO_ACCOUNT,
    debug = !!process.env.DEGIRO_DEBUG,
} = {}) => {
    const log = debug ? (...s) => console.log(...s) : () => {};

    const session = {
        id: sessionId,
        account,
        userToken: null,
        clientInfo: null,
    };

    const urls = {
        paUrl: null,
        productSearchUrl: null,
        productTypesUrl: null,
        reportingUrl: null,
        tradingUrl: null,
        vwdQuotecastServiceUrl: null,
    };

    const checkSuccess = res => {
        if (res.status !== 0) {
            throw Error(res.message);
        }
        return res;
    };

    /**
     * Gets data
     *
     * @return {Promise}
     */
    const getData = (options = {}) => {
        const params = querystring.stringify(options);
        const url = `${urls.tradingUrl}v5/update/${session.account};jsessionid=${session.id}?${params}`
        log('getData url: GET', url);
        return fetch(url)
        .then(res => res.json())
        .then(res => log('getData response:', JSON.stringify(res)));
    };

    /**
     * Get current cash funds
     *
     * @return {Promise}
     */
    const getCashFunds = () => {
        return getData({cashFunds: 0}).then(data => {
            if (data.cashFunds && Array.isArray(data.cashFunds.value)) {
                return {
                    cashFunds: data.cashFunds.value.map(({value}) =>
                        omit(fromPairs(value.map(({name, value}) => [name, value])), [
                            'handling',
                            'currencyCode',
                        ])
                    ),
                };
            }
            throw Error('Bad result: ' + JSON.stringify(data));
        });
    };

    /**
     * Create a session at VWD services
     *
     * @return {Promise}
     */
    const requestVwdSession = () => {
        const url = `https://degiro.quotecast.vwdservices.com/CORS/request_session?version=1.0.20170315&userToken=${session.userToken}`
        const method = 'POST'
        const headers = {Origin: 'https://trader.degiro.nl'}
        const body = JSON.stringify({referrer: 'https://trader.degiro.nl'})
        log('requestVwdSession url:', method, url);
        log('requestVwdSession header:', JSON.stringify(headers));
        log('requestVwdSession body:', body);

        return fetch(url, {
            method: method,
            headers: headers,
            body: body,
        })
        .then(res => res.json())
        .then(res => log('requestVwdSession response:', JSON.stringify(res)));
    };

    /**
     * Use VWD session to get latest bid/ask prices for a VWD issue ID
     *
     * @return {Promise}
     */
    const getAskBidPrice = (issueId, timesChecked = 0) =>
        requestVwdSession().then(vwdSession => {
            const checkData = res => {
                timesChecked++;
                const prices = {};

                // sanity check
                if (!Array.isArray(res)) {
                    throw Error('Bad result: ' + JSON.stringify(res));
                }

                // retry needed?
                if (res.length == 1 && res[0].m == 'h') {
                    if (timesChecked <= 3) {
                        return getAskBidPrice(issueId, timesChecked);
                    } else {
                        throw Error(
                            'Tried 3 times to get data, but nothing was returned: ' + JSON.stringify(res)
                        );
                    }
                }

                // process incoming data
                var keys = [];
                res.forEach(row => {
                    if (row.m == 'a_req') {
                        if (row.v[0].startsWith(issueId)) {
                            var key = lcFirst(row.v[0].slice(issueId.length + 1));
                            prices[key] = null;
                            keys[row.v[1]] = key;
                        }
                    } else if (row.m == 'un' || row.m == 'us') {
                        prices[keys[row.v[0]]] = row.v[1];
                    }
                });

                // check if everything is there
                if (
                    typeof prices.bidPrice == 'undefined' ||
                    typeof prices.askPrice == 'undefined' ||
                    typeof prices.lastPrice == 'undefined' ||
                    typeof prices.lastTime == 'undefined'
                ) {
                    throw Error("Couldn't find all requested info: " + JSON.stringify(res));
                }

                return prices;
            };
            const url = `https://degiro.quotecast.vwdservices.com/CORS/${vwdSession.sessionId}`;
            const method = 'POST'
            const headers = {Origin: 'https://trader.degiro.nl'}
            const body = JSON.stringify({
                controlData: `req(${issueId}.BidPrice);req(${issueId}.AskPrice);req(${
                                    issueId
                                  }.LastPrice);req(${
                                    issueId
                                  }.LastTime);`,
            })
            log('getAskBidPrice url:', url);
            log('getAskBidPrice header:', JSON.stringify(headers));
            log('getAskBidPrice body:', body);

            return fetch(url, {
                method: method,
                headers: headers,
                body: body,
            })
                .then(() => fetch(`https://degiro.quotecast.vwdservices.com/CORS/${vwdSession.sessionId}`))
                .then(res => res.json())
                .then(log('getAskBidPrice response:', JSON.stringify(res)))
                .then(checkData);
        });

    /**
     * Get portfolio
     *
     * @return {Promise}
     */
    const getPortfolio = () => {
        return getData({portfolio: 0}).then(data => {
            if (data.portfolio && Array.isArray(data.portfolio.value)) {
                return {portfolio: data.portfolio.value};
            }
            throw Error('Bad result: ' + JSON.stringify(data));
        });
    };

    /**
     * Get orders
     *
     * @return {Promise}
     */
    const getOrders = () => {
        return getData({orders: 0, historicalOrders: 0, transactions: 0}).then(data => {
            if (
                data.orders &&
                Array.isArray(data.orders.value) &&
                data.historicalOrders &&
                Array.isArray(data.historicalOrders.value) &&
                data.transactions &&
                Array.isArray(data.transactions.value)
            ) {
                const processOrders = function(orders) {
                    var res = [];

                    orders.forEach(function(order) {
                        var o = {
                            id: order.id,
                        };

                        order.value.forEach(function(orderRow) {
                            if (orderRow.name == 'date') {
                                if (orderRow.value.includes(':')) {
                                    o[orderRow.name] = new Date();
                                    o[orderRow.name].setHours(orderRow.value.split(':')[0]);
                                    o[orderRow.name].setMinutes(orderRow.value.split(':')[1]);
                                    o[orderRow.name].setSeconds(0);
                                    o[orderRow.name].setMilliseconds(0);
                                } else if (orderRow.value.includes('/')) {
                                    var currentDate = new Date();
                                    var month = orderRow.value.split('/')[1];

                                    o[orderRow.name] = new Date(
                                        currentDate.getMonth() < month
                                            ? currentDate.getYear() - 1
                                            : currentDate.getYear(),
                                        month,
                                        orderRow.value.split('/')[0]
                                    );
                                } else {
                                    throw Error('Unexpected date format: ' + orderRow.value);
                                }
                            } else {
                                o[orderRow.name] = orderRow.value;
                            }
                        });

                        res.push(o);
                    });

                    return res;
                };

                return {
                    openOrders: processOrders(data.orders.value),
                    cancelledOrders: processOrders(data.historicalOrders.value),
                    completedOrders: processOrders(data.transactions.value),
                };
            }
            throw Error('Bad result: ' + JSON.stringify(data));
        });
    };

    /**
     * Get client info
     *
     * @return {Promise}
     */
    const getClientInfo = () => {
        const url = `${urls.paUrl}client?sessionId=${session.id}`
        log('getClientInfo url: GET', url);

        return fetch(url)
        .then(res => res.json())
        .then(clientInfo => {
            log('getClientInfo response:', JSON.stringify(clientInfo));
            const data = clientInfo.data;
            session.account = data.intAccount;
            session.userToken = data.id;
            session.clientInfo = data;
            return data;
    })};

    /**
     * Get config
     *
     * @return {Promise}
     */
    const updateConfig = () => {
        const url = `${BASE_TRADER_URL}/login/secure/config`
        const headers = {headers: {Cookie: `JSESSIONID=${session.id};`}}
        log('config url: GET', url);
        log('config headers:', JSON.stringify(headers));

        return fetch(url, headers)
        .then(res => res.json())
        .then(res => {
            log('config response:', JSON.stringify(res));
            urls.paUrl = res.data.paUrl;
            urls.productSearchUrl = res.data.productSearchUrl;
            urls.productTypesUrl = res.data.productTypesUrl;
            urls.reportingUrl = res.data.reportingUrl;
            urls.tradingUrl = res.data.tradingUrl;
            urls.vwdQuotecastServiceUrl = res.data.vwdQuotecastServiceUrl;
    })};

    /**
     * Login
     *
     * @return {Promise} Resolves to {sessionId: string}
     */
    const login = () => {
        let url = `${BASE_TRADER_URL}/login/secure/login`;
        let loginParams = {
            username,
            password,
            isRedirectToMobile: false,
            loginButtonUniversal: '',
            queryParams: {reason: 'session_expired'},
        };

        if (oneTimePassword) {
            log('2fa token', oneTimePassword);
            url += '/totp';
            loginParams.oneTimePassword = oneTimePassword;
        }
        return sendLoginRequest(url, loginParams);
    };

    const sendLoginRequest = (url, params) => {
        const method = 'POST'
        const headers = {'Content-Type': 'application/json'}
        let obfuscatedParams = Object.assign({}, params)
        obfuscatedParams.password = '********';        
        log('login url:', method , url);
        log('login headers:', headers);
        log('login request:', JSON.stringify(obfuscatedParams));
        
        return fetch(url, {
            method: method,
            headers: headers,
            body: JSON.stringify(params),
        })
        .then(res => {
              const cookies = parseCookies(res.headers.get('set-cookie') || '');
              session.id = cookies.JSESSIONID;
              if (!session.id) {
                  throw Error('login nok');
              }
              log('login ok!');
              log('login response:', JSON.stringify(res));
              log('cookies:', JSON.stringify(cookies));
              log('session.id:', session.id);
        })
        .then(updateConfig)
        .then(getClientInfo)
        .then(() => session);
    };

    /**
     * Search product by name and type
     *
     * @param {string} options.text - Search term. For example: "Netflix" or "NFLX"
     * @param {number} options.productType - See ProductTypes. Defaults to ProductTypes.all
     * @param {number} options.sortColumn - Column to sory by. For example: "name". Defaults to `undefined`
     * @param {number} options.sortType - See SortTypes. Defaults to `undefined`
     * @param {number} options.limit - Results limit. Defaults to 7
     * @param {number} options.offset - Results offset. Defaults to 0
     * @return {Promise} Resolves to {data: Product[]}
     */
    const searchProduct = ({
        text: searchText,
        productType = ProductTypes.all,
        sortColumn,
        sortType,
        limit = 7,
        offset = 0,
    }) => {
        const options = {
            searchText,
            productTypeId: productType,
            sortColumns: sortColumn,
            sortTypes: sortType,
            limit,
            offset,
        };
        const params = querystring.stringify(omitBy(options, isNil));
        const url = `${urls.productSearchUrl}v5/products/lookup?intAccount=${
                          session.account
                        }&sessionId=${
                          session.id
                        }&${params}`
        log('searchProduct url: GET', url);

        return fetch(url)
               .then(res => res.json())
               .then(productInfo => {
                    log('searchProduct response:', JSON.stringify(productInfo));
                    return productInfo;
               });
    };

    /**
     * Delete order
     *
     * @param {string} order.productId
     * @return {Promise} Resolves to {status: 0, statusText: "success"}
     */
    const deleteOrder = orderId => {
        const method = 'DELETE'
        const url = `${urls.tradingUrl}v5/order/${orderId};jsessionid=${
                          session.id
                        }?intAccount=${
                          session.account
                        }&sessionId=${
                          session.id}`
        const headers = {'Content-Type': 'application/json;charset=UTF-8'}
        log('deleteOrder url:', method, url);
        log('deleteOrder headers:', JSON.stringify(headers));

        return fetch(url, {
            method: method,
            headers: headers,
            body: JSON.stringify(params),
        })
        .then(res => res.json())
        .then(res => {
            log('deleteOrder response:', JSON.stringify(res));
            if (res.status == 0 && res.statusText == 'success') {
                return true;
                log('order deleted');
            } else {
                throw Error('delete order failed');
            }
       });
    };

    /**
     * Check order
     *
     * @param {number} order.action - See Actions
     * @param {number} order.orderType - See OrderTypes
     * @param {string} order.productId
     * @param {number} order.size
     * @param {number} order.timeType - See TimeTypes
     * @param {number} order.price - Required for limited and stopLimited orders
     * @param {number} order.stopPrice - Required for stopLoss and stopLimited orders
     * @return {Promise} Resolves to {order: Object, confirmationId: string}
     */
    const checkOrder = order => {
        const {buySell, orderType, productId, size, timeType, price, stopPrice} = order;
        const url = `${urls.tradingUrl}v5/checkOrder;jsessionid=${
                          session.id
                        }?intAccount=${
                          session.account
                        }&sessionId=${session.id}`
        const method = 'POST'
        const headers = {'Content-Type': 'application/json;charset=UTF-8'}
        log('checkOrder url:', method, url);
        log('checkOrder header:', JSON.stringify(headers));
        log('checkOrder body:', JSON.stringify(order));

        return fetch(url, {
            method: method,
            headers: headers,
            body: JSON.stringify(order),
        })
        .then(res => res.json())
        .then(res => log('checkOrder response:', JSON.stringify(res)))
        .then(checkSuccess)
        .then(json => ({order, confirmationId: json.confirmationId}));
    };

    /**
     * Confirm order
     *
     * @param {Object} options.order - As returned by checkOrder()
     * @param {string} options.confirmationId - As returned by checkOrder()
     * @return {Promise} Resolves to {orderId: string}
     */
    const confirmOrder = ({order, confirmationId}) => {
        const {buySell, orderType, productId, size, timeType, price, stopPrice} = order;
        const url = `${urls.tradingUrl}v5/order/${confirmationId};jsessionid=${
                          session.id
                        }?intAccount=${
                          session.account
                        }&sessionId=${session.id}`
        const method = 'POST'
        const headers = {'Content-Type': 'application/json;charset=UTF-8'}
        log('confirmOrder url:', method, url);
        log('confirmOrder header:', JSON.stringify(headers));
        log('confirmOrder body:', JSON.stringify(order));

        return fetch(url, {
            method: method,
            headers: headers,
            body: JSON.stringify(order),
        })
        .then(res => res.json())
        .then(res => log('checkOrder response:', JSON.stringify(res)))
        .then(checkSuccess)
        .then(json => ({orderId: json.orderId}));
    };

    /**
     * Check and place Order
     *
     * @param {number} options.buySell - See Actions
     * @param {number} options.orderType - See OrderTypes
     * @param {string} options.productId - Product id
     * @param {number} options.size - Number of items to buy
     * @param {number} options.timeType - See TimeTypes. Defaults to TimeTypes.day
     * @param {number} options.price
     * @param {number} options.stopPrice
     */
    const setOrder = ({buySell, orderType, productId, size, timeType = TimeTypes.day, price, stopPrice}) =>
        checkOrder({buySell, orderType, productId, size, timeType, price, stopPrice}).then(confirmOrder);

    /**
     * Get multiple products by its IDs
     *
     * @param {(string|string[])} ids - ID or Array of IDs of the products to query
     */
    const getProductsByIds = ids => {
        if (!Array.isArray(ids)) {
            ids = [ids];
        }
        
        const url = `${urls.productSearchUrl}v5/products/info?intAccount=${
                          session.account
                        }&sessionId=${
                          session.id}`
        const method = 'POST'
        const headers = {'Content-Type': 'application/json'}
        const body = JSON.stringify(ids.map(id => id.toString()))
        log('getProductsByIds url:', method, url);
        log('getProductsByIds header:', JSON.stringify(headers));
        log('getProductsByIds body:', body);

        return fetch(url, {
            method: method,
            headers: headers,
            body: body,
        })
        .then(res => res.json())
        .then(res => log('getProductsByIds response:', JSON.stringify(res)));
    };

    return {
        // methods
        login,
        searchProduct,
        getData,
        getCashFunds,
        getPortfolio,
        getAskBidPrice,
        setOrder,
        deleteOrder,
        getOrders,
        getProductsByIds,
        getClientInfo,
        updateConfig,
        // properties
        session,
    };
};

module.exports = {
    create,
    Actions,
    OrderTypes,
    ProductTypes,
    TimeTypes,
    Sort,
};