import {
    type IPLicenseTerms,
    type PILTerms,
    QUERY_ORDER_BY,
    QUERY_ORDER_DIRECTION,
    type QueryOptions,
    RESOURCE_TYPE,
    type ResourceType,
    type Trait,
} from "../types/api";
import { elizaLogger } from "@elizaos/core";

import { camelize } from "./utils";
const API_BASE_URL = process.env.STORY_API_BASE_URL;
const API_VERSION = "v2";
export const API_URL = `${API_BASE_URL}/${API_VERSION}`;
export const API_KEY = process.env.STORY_API_KEY || "";

export async function getResource(
    resourceName: ResourceType,
    resourceId: string,
    // eslint-disable-next-line
    _options?: QueryOptions
) {
    try {
        elizaLogger.log(
            `Fetching resource ${API_URL}/${resourceName}/${resourceId}`
        );
        const res = await fetch(`${API_URL}/${resourceName}/${resourceId}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": API_KEY as string,
                "x-chain": "1516",
            },
        });
        if (res.ok) {
            elizaLogger.log("Response is ok");
            return res.json();
        }
        elizaLogger.log("Response is not ok");
        elizaLogger.log(JSON.stringify(res));
        throw new Error(`HTTP error! status: ${res.status}`);
    } catch (error) {
        console.error(error);
    }
}


export async function listResource(
    resourceName: ResourceType,
    options?: QueryOptions
) {
    try {
        const _options = {
            pagination: {
                limit: 10,
                offset: 0,
            },
            orderBy: QUERY_ORDER_BY.BLOCK_NUMBER,
            orderDirection: QUERY_ORDER_DIRECTION.DESC,
            ...options,
        };
        elizaLogger.log(`Calling Story API ${resourceName}`);
        elizaLogger.log(`STORY_API_KEY: ${API_KEY}`);
        elizaLogger.log(`API_URL: ${API_URL}`);
        elizaLogger.log(`API_VERSION: ${API_VERSION}`);
        elizaLogger.log(`_options: ${JSON.stringify(_options)}`);
        const res = await fetch(`${API_URL}/${resourceName}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": API_KEY as string,
                "x-chain": "1516",
            },
            cache: "no-cache",
            ...(_options && { body: JSON.stringify({ options: _options }) }),
        });
        if (res.ok) {
            elizaLogger.log("Response is ok");
            elizaLogger.log(res.ok);
            return res.json();
        }
        elizaLogger.log("Response is not ok");
        elizaLogger.log(res);
        return res;
    } catch (error) {
        elizaLogger.log("List resource Error");
        console.error(error);
    }
}

export async function fetchLicenseTermsDetails(data: IPLicenseTerms[]) {
    const requests = data.map((item) =>
        getResource(RESOURCE_TYPE.LICENSE_TERMS, item.licenseTermsId)
    );
    const results = await Promise.all(requests);

    return results
        .filter((value) => !!value)
        .map((result) => {
            return {
                ...result.data,
                licenseTerms: convertLicenseTermObject(
                    result.data.licenseTerms
                ),
            };
        });
}

type LicenseTerms = Partial<PILTerms>;

export function convertLicenseTermObject(licenseTerms: Trait[]): LicenseTerms {
    return licenseTerms.reduce((acc, option: Trait): LicenseTerms => {
        const key = camelize(option.trait_type) as keyof PILTerms;
        acc[key] =
            option.value === "true"
                ? true
                : option.value === "false"
                  ? false
                  : option.value as string | number;  // Replaced any with string | number
        return acc as LicenseTerms;
    }, {});
}
