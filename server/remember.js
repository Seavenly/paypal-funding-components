/* @flow */

import { unpackSDKMeta } from '@paypal/sdk-client';
import { FUNDING } from '@paypal/sdk-constants';

import type { ExpressRequest, ExpressResponse } from './types';
import { QUERY_PARAM, HTTP_RESPONSE_HEADER } from './constants';
import { getSDKCookie, writeSDKCookie, type CookiesType } from './cookie';
import { getNonce, getQuery, buildCSP, getTimestamp } from './util';
import { COOKIE_SETTINGS } from './config';

export function isFundingRemembered(req : ExpressRequest, fundingSource : $Values<typeof FUNDING>, opts? : { cookies? : CookiesType } = {}) : boolean {
    const cookies = opts.cookies || req.cookies || {};
    const cookieSettings = COOKIE_SETTINGS[fundingSource] || {};

    if (cookieSettings.legacyRead && cookieSettings.legacyKey && cookies[cookieSettings.legacyKey]) {
        return true;
    }
    
    const sdkCookie = getSDKCookie(req, cookies);
    const funding = sdkCookie.funding || {};
    const fundingConfig = funding[fundingSource] || {};
    
    if (fundingConfig.expiry && fundingConfig.expiry < getTimestamp()) {
        return false;
    }

    return Boolean(fundingConfig.remembered);
}

export function rememberFunding(req : ExpressRequest, res : ExpressResponse, fundingSources : $ReadOnlyArray<$Values<typeof FUNDING>>) {
    const sdkCookie = getSDKCookie(req);
    const funding = sdkCookie.funding = sdkCookie.funding || {};

    for (const fundingSource of fundingSources) {
        const fundingConfig =  funding[fundingSource] = sdkCookie.funding[fundingSource] || {};
        fundingConfig.remembered = true;

        const cookieSettings = COOKIE_SETTINGS[fundingSource] || {};
        if (cookieSettings.legacyWrite && cookieSettings.legacyKey) {
            res.cookie(cookieSettings.legacyKey, '1');
        }

        if (cookieSettings.expiry) {
            fundingConfig.expiry = (getTimestamp() + cookieSettings.expiry);
        }
    }

    writeSDKCookie(res, sdkCookie);
}

type RememberFundingOptions = {|
    allowedClients : {
        [string] : {|
            allowedFunding : $ReadOnlyArray<$Values<typeof FUNDING>>,
            allowedDomains : $ReadOnlyArray<string>
        |}
    }
|};

type RememberFundingMiddleware = (ExpressRequest, ExpressResponse) => void | ExpressResponse;

function parseFundingSources(commaSeparatedFundingSources) : $ReadOnlyArray<$Values<typeof FUNDING>> {
    const fundingSources = commaSeparatedFundingSources.split(',');
    // $FlowFixMe
    return fundingSources;
}

function setSecurityHeaders(res : ExpressResponse, { nonce, domain } : { nonce : string, domain : string }) {
    res.setHeader(HTTP_RESPONSE_HEADER.CONTENT_SECURITY_POLICY, buildCSP({
        'script-src':      `'self' https://*.paypal.com:* 'nonce-${ nonce }'`,
        'connect-src':     `'self' https://*.paypal.com:*`,
        'frame-ancestors': `${ domain }`,
        'img-src':         `data:`,
        'style-src':       `'none'`,
        'frame-src':       `'none'`,
        'font-src':        `'none'`,
        'object-src':      `'none'`,
        'media-src':       `'none'`
    }));

    res.setHeader(HTTP_RESPONSE_HEADER.ACCESS_CONTROL_ALLOW_ORIGIN, domain);
}

export function rememberFundingIframe({ allowedClients = {} } : RememberFundingOptions) : RememberFundingMiddleware {
    return (req, res) => {
        const {
            [ QUERY_PARAM.DOMAIN ]:          domain,
            [ QUERY_PARAM.FUNDING_SOURCES ]: commaSeparatedFundingSources,
            [ QUERY_PARAM.SDK_META ]:        sdkMeta,
            [ QUERY_PARAM.CLIENT_ID ]:       clientID
        } = getQuery(req);

        if (!commaSeparatedFundingSources) {
            return res.status(400).send(`Expected ${ QUERY_PARAM.FUNDING_SOURCES } query param`);
        }

        if (!sdkMeta) {
            return res.status(400).send(`Expected ${ QUERY_PARAM.SDK_META } query param`);
        }

        if (!clientID) {
            return res.status(400).send(`Expected ${ QUERY_PARAM.CLIENT_ID } query param`);
        }

        if (!domain || !domain.match(/^https?:\/\/[a-zA-Z_0-9.-]+$/)) {
            return res.status(400).send(`Expected ${ QUERY_PARAM.DOMAIN } query param`);
        }

        const clientConfig = allowedClients[clientID];

        if (!clientConfig) {
            return res.status(400).send(`Invalid client id: ${ clientID }`);
        }

        const { allowedFunding, allowedDomains } = clientConfig;
        const fundingSources = parseFundingSources(commaSeparatedFundingSources);
        const validFunding = Object.values(FUNDING);
    
        for (const fundingSource of fundingSources) {
            if (validFunding.indexOf(fundingSource) === -1) {
                return res.status(400).send(`Invalid funding source: ${ fundingSource }`);
            }

            if (allowedFunding.indexOf(fundingSource) === -1) {
                return res.status(400).send(`Funding source not allowed for client: ${ fundingSource }`);
            }
        }

        if (allowedDomains.indexOf(domain) === -1) {
            return res.status(400).send(`Domain not allowed for client: ${ domain }`);
        }

        let meta;

        try {
            meta = unpackSDKMeta(req.query.sdkMeta);
        } catch (err) {
            return res.status(400).send(`Invalid sdk meta: ${ sdkMeta.toString() }`);
        }

        rememberFunding(req, res, fundingSources);

        const nonce = getNonce();
        const { getSDKLoader } = meta;

        setSecurityHeaders(res, { domain, nonce });

        res.status(200).send(`
            <!DOCTYPE html>
            <head>
                <link rel="icon" href="data:;base64,=">
                ${ getSDKLoader({ nonce }) }
                <script nonce="${ nonce }">
                    paypal.rememberFunding(${ JSON.stringify(fundingSources) });
                </script>
            </head>
        `);
    };
}
