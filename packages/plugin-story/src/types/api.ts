import type { Address, Hash } from "viem";

export enum ACTION_RESPONSE_TYPE {
    SET = "SET",
    ATTACH = "ATTACH",
    CREATE = "CREATE",
    REGISTER = "REGISTER",
    REMOVE = "REMOVE",
}

export enum RESOURCE_TYPE {
    LICENSE_TOKEN = "licenses/tokens", // new version
    LICENSE_TEMPLATES = "licenses/templates", // new version
    LICENSE_TERMS = "licenses/terms", // new version
    IP_LICENSE_TERMS = "licenses/ip/terms", // new version
    IP_LICENSE_DETAILS = "detailed-ip-license-terms", // new version
    ASSET = "assets",
    COLLECTION = "collections",
    DISPUTE = "disputes",
    LICENSE_MINT_FEES = "licenses/mintingfees",
    MODULE = "modules",
    PERMISSION = "permissions",
    ROYALTY = "royalties",
    ROYALTY_PAY = "royalties/payments",
    ROYALTY_POLICY = "royalties/policies",
    ROYALTY_SPLIT = "royalties/splits",
    TAGS = "tags",
    TRANSACTION = "transactions",
    LATEST_TRANSACTIONS = "transactions/latest",
}

export enum RESPOURCE_REPONSE_TYPE {
    LICENSE_TOKEN = "LICENSETOKEN", // new version
    LICENSE_TEMPLATES = "LICENSETEMPLATE", // new version
    LICENSE_TERMS = "LICENSETERM", // new version
    IP_LICENSE_TERMS = "licenses/ip/terms", // new version
    IP_LICENSE_DETAILS = "detailed-ip-license-terms", // new version
    ASSET = "IPASSET",
    COLLECTION = "COLLECTION",
    DISPUTE = "DISPUTE",
    LICENSE_MINT_FEES = "licenses/mintingfees",
    MODULE = "modules",
    PERMISSION = "PERMISSION",
    ROYALTY = "ROYALTY",
    ROYALTY_PAY = "royalties/payments",
    ROYALTY_POLICY = "ROYALTYPOLICY",
    ROYALTY_SPLIT = "royalties/splits",
    TAGS = "tags",
}

export type ResourceType =
    | RESOURCE_TYPE.ASSET
    | RESOURCE_TYPE.COLLECTION
    | RESOURCE_TYPE.TRANSACTION
    | RESOURCE_TYPE.LATEST_TRANSACTIONS
    | RESOURCE_TYPE.LICENSE_TOKEN
    | RESOURCE_TYPE.LICENSE_TERMS
    | RESOURCE_TYPE.LICENSE_TEMPLATES
    | RESOURCE_TYPE.IP_LICENSE_TERMS
    | RESOURCE_TYPE.IP_LICENSE_DETAILS
    | RESOURCE_TYPE.LICENSE_MINT_FEES
    | RESOURCE_TYPE.MODULE
    | RESOURCE_TYPE.PERMISSION
    | RESOURCE_TYPE.TAGS
    | RESOURCE_TYPE.ROYALTY
    | RESOURCE_TYPE.ROYALTY_PAY
    | RESOURCE_TYPE.ROYALTY_POLICY
    | RESOURCE_TYPE.ROYALTY_SPLIT
    | RESOURCE_TYPE.DISPUTE;

export type PaginationOptions = {
    limit?: number;
    offset?: number;
};

export type AssetFilterOptions = {
    chainId?: string;
    metadataResolverAddress?: string;
    tokenContract?: string;
    tokenId?: string;
};

export type DisputeFilterOptions = {
    currentTag?: string;
    initiator?: string;
    targetIpId?: string;
    targetTag?: string;
};

export type PermissionFilterOptions = {
    signer?: string;
    to?: string;
};

export type PolicyFilterOptions = {
    policyFrameworkManager?: string;
};

export type PolicyFrameworkFilterOptions = {
    address?: string;
    name?: string;
};

export type RoyaltyFilterOptions = {
    ipId?: string | null;
    royaltyPolicy?: string | null;
};

export type TagFilterOptions = {
    ipId?: string;
    tag?: string;
};
export type RoyaltyPayFilterOptions = {
    ipId?: string;
    payerIpId?: string;
    receiverIpId?: string;
    sender?: string;
    token?: string;
};

export type ModuleFilterOptions = {
    name?: string;
};

export type LicenseFilterOptions = {
    licensorIpId?: string;
    policyId?: string;
};

export type LicenseFrameworkFilterOptions = {
    creator?: string;
};

export type IPAPolicyFilterOptions = {
    active?: string;
    inherited?: string;
    policyId?: string;
};

export type TransactionFilterOptions = {
    actionType?: string;
    resourceId?: string;
};

export type FilterOptions =
    | AssetFilterOptions
    | DisputeFilterOptions
    | PermissionFilterOptions
    | PolicyFilterOptions
    | PolicyFrameworkFilterOptions
    | RoyaltyFilterOptions
    | TagFilterOptions
    | RoyaltyPayFilterOptions
    | ModuleFilterOptions
    | LicenseFilterOptions
    | LicenseFrameworkFilterOptions
    | IPAPolicyFilterOptions
    | TransactionFilterOptions;

export type QueryHeaders =
    | {
          "x-api-key": string;
          "x-chain": string;
          "x-extend-asset"?: string;
      }
    | object;

export enum QUERY_ORDER_BY {
    BLOCK_TIMESTAMP = "blockTimestamp",
    BLOCK_NUMBER = "blockNumber",
    TOKEN_ID = "tokenId",
    ASSET_COUNT = "assetCount",
    LICENSES_COUNT = "licensesCount",
    DESCENDANT_COUNT = "descendantCount",
    // PARENTS = "parentIpIds",
}

export enum QUERY_ORDER_DIRECTION {
    ASC = "asc",
    DESC = "desc",
}

export type QueryOptions = {
    chain?: string | number;
    pagination?: PaginationOptions;
    where?: FilterOptions;
    orderBy?: QUERY_ORDER_BY;
    orderDirection?: QUERY_ORDER_DIRECTION;
};

export type Transaction = {
    id: string;
    createdAt: string;
    actionType: string;
    initiator: Address;
    ipId: Address;
    resourceId: Address;
    resourceType: string;
    blockNumber: string;
    blockTimestamp: string;
    logIndex: string;
    transactionIndex: string;
    tx_hash: Hash;
};

export type AssetNFTMetadata = {
    name: string;
    chainId: string;
    tokenContract: Address;
    tokenId: string;
    tokenUri: string;
    imageUrl: string;
};

export type Permission = {
    id: string;
    permission: string;
    signer: Address;
    to: Address;
    func: string;
    blockNumber: string;
    blockTimestamp: string;
};

export type PolicyFramework = {
    id: string;
    address: Address;
    name: string;
    blockNumber: string;
    blockTimestamp: string;
};

export type Module = {
    id: string;
    name: string;
    module: string;
    blockNumber: string;
    blockTimestamp: string;
    deletedAt: string;
};

export type Tag = {
    id: string;
    uuid: string;
    ipId: Address;
    tag: string;
    deletedAt: string;
    blockNumber: string;
    blockTimestamp: string;
};

export type IPAPolicy = {
    id: string;
    ipId: Address;
    policyId: Address;
    index: string;
    active: boolean;
    inherited: boolean;
    blockNumber: string;
    blockTimestamp: string;
};

export type RoyaltyPay = {
    id: string;
    receiverIpId: Address;
    payerIpId: Address;
    sender: Address;
    token: Address;
    amount: string;
    blockNumber: string;
    blockTimestamp: string;
};

export type Royalty = {
    id: string;
    ipId: Address;
    data: string;
    royaltyPolicy: Address;
    blockNumber: string;
    blockTimestamp: string;
};

export type Dispute = {
    id: string;
    targetIpId: Address;
    targetTag: Address;
    currentTag: Address;
    arbitrationPolicy: Address;
    evidenceLink: string;
    initiator: Address;
    data: string;
    blockNumber: string;
    blockTimestamp: string;
};

export type Collection = {
    id: string;
    assetCount: string;
    licensesCount: string;
    resolvedDisputeCount: string;
    cancelledDisputeCount: string;
    raisedDisputeCount: string;
    judgedDisputeCount: string;
    blockNumber: string;
    blockTimestamp: string;
};

export type Policy = {
    id: string;
    policyFrameworkManager: Address;
    frameworkData: string;
    royaltyPolicy: Address;
    royaltyData: string;
    mintingFee: string;
    mintingFeeToken: Address;
    blockNumber: string;
    blockTimestamp: string;
    pil: PILType;
};

export type PILType = {
    id: Hash;
    attribution: boolean;
    commercialUse: boolean;
    commercialAttribution: boolean;
    commercializerChecker: Address;
    commercializerCheckerData: string;
    commercialRevShare: string;
    derivativesAllowed: boolean;
    derivativesAttribution: boolean;
    derivativesApproval: boolean;
    derivativesReciprocal: boolean;
    territories: string[];
    distributionChannels: string[];
    contentRestrictions: string[];
};

export type RoyaltySplit = {
    id: Address;
    holders: RoyaltyHolder[];
    claimFromIPPoolArg: string;
};

export type RoyaltyHolder = {
    id: Address;
    ownership: string;
};

export type LicenseToken = {
    id: string;
    licensorIpId: Address;
    licenseTemplate: Address;
    licenseTermsId: string;
    transferable: boolean;
    owner: Address;
    mintedAt: string;
    expiresAt: string;
    burntAt: string;
    blockNumber: string;
    blockTime: string;
};

export type LicenseTemplate = {
    id: string;
    name: string;
    metadataUri: string;
    blockNumber: string;
    blockTime: string;
};

export type SocialMedia = {
    platform?: string;
    url?: string;
};

export type Creator = {
    name?: string;
    address?: Address;
    description?: string;
    contributionPercent?: number;
    socialMedia?: SocialMedia[];
};

export interface IPMetadata {
    title?: string;
    description?: string;
    ipType?: string;
    creators?: Creator[];
    appInfo?: {
        id?: string;
        name?: string;
        website?: string;
    }[];
    relationships?: {
        parentIpId?: Address;
        type?: string;
    }[];
    robotTerms?: {
        userAgent?: string;
        allow?: string;
    };
    [key: string]: unknown;  // Replaced any with unknown
}

export interface AssetMetadata {
    id: Address;
    metadataHash: string;
    metadataUri: string;
    metadataJson: IPMetadata;
    nftMetadataHash: string;
    nftTokenUri: string;
    registrationDate: string;
}

export type UserCollection = {
    id?: number;
    user_id?: number;
    tx_hash?: Hash;
    chain?: string;
    chain_id?: string;
    collection_address?: Address;
    collection_name?: string;
    collection_thumb?: string;
    collection_banner?: string;
    collection_description?: string;
    created_at?: string;
    updated_at?: string;
    User?: null;
};

export enum PIL_FLAVOR {
    NON_COMMERCIAL_SOCIAL_REMIXING = "Non-Commercial Social Remixing",
    COMMERCIAL_USE = "Commercial Use",
    COMMERCIAL_REMIX = "Commercial Remix",
    CUSTOM = "Custom",
    // OPEN_DOMAIN = "Open Domain",
    // NO_DERIVATIVE = "No Derivative",
}

export type PilFlavor =
    | PIL_FLAVOR.NON_COMMERCIAL_SOCIAL_REMIXING
    | PIL_FLAVOR.COMMERCIAL_USE
    | PIL_FLAVOR.COMMERCIAL_REMIX
    | PIL_FLAVOR.CUSTOM;

export type Asset = {
    id: Address;
    ancestorCount: number;
    descendantCount: number;
    parentCount?: number;
    childCount?: number;
    rootCount?: number;
    parentIpIds: Address[] | null;
    childIpIds: Address[] | null;
    rootIpIds: Address[] | null;
    parentIps?: Asset[] | null;
    rootIps?: Asset[] | null;
    childIps?: Asset[] | null;
    nftMetadata: {
        name: string;
        chainId: string;
        tokenContract: Address;
        tokenId: string;
        tokenUri: string;
        imageUrl: string;
    };
    blockNumber: string;
    blockTimestamp: string;
};

export type AssetEdges = {
    ipId: Address;
    parentIpId: Address;
    blockNumber: string;
    blockTime: string;
    licenseTemplate: Address;
    licenseTermsId: string;
    licenseTokenId: string;
    transactionHash: string;
    transactionIndex: string;
};

export type License = {
    id: string;
    licensorIpId: Address;
    licenseTemplate: string;
    licenseTermsId: string;
    transferable: boolean;
    owner: Address;
    mintedAt: string;
    expiresAt: string;
    burntAt: string;
    blockNumber: string;
    blockTime: string;
};

export type PILTerms = {
    commercialAttribution: boolean;
    commercialRevenueCelling: number;
    commercialRevenueShare: number;
    commercialUse: boolean;
    commercializerCheck: Address;
    currency: Address;
    derivativesAllowed: boolean;
    derivativesApproval: boolean;
    derivativesAttribution: boolean;
    derivativesReciprocal: boolean;
    derivativesRevenueCelling: number;
    expiration: string;
    uRI: string;
};

export type IPLicenseDetails = {
    id: string;
    ipId: Address;
    licenseTemplateId: string;
    licenseTemplate: {
        id: string;
        name: string;
        metadataUri: string;
        blockNumber: string;
        blockTime: string;
    };
    terms: PILTerms;
};
export type IPLicenseTerms = {
    id: string;
    ipId: Address;
    licenseTemplate: string;
    licenseTermsId: string;
    blockNumber: string;
    blockTime: string;
};

export type RoyaltyPolicy = {
    id: Address;
    ipRoyaltyVault: Address;
    splitClone: Address;
    royaltyStack: string;
    targetAncestors: Address[];
    targetRoyaltyAmount: string[];
    blockNumber: string;
    blockTimestamp: string;
};

export interface Trait {
    trait_type: string;
    value: string | number;
    max_value?: number;
}

export type LicenseTerms = {
    id: string;
    // json: string
    licenseTerms: Trait[];
    licenseTemplate: Address;
    blockNumber: string;
    blockTime: string;
};