export type NetworkType = "evm" | "sol" | "utxo" | "cosmos" | "tron";
export type TxnType = "on-chain" | "sign-untyped" | "sign-typed";
export const enum Providers {
    ONEINCH = "1inch",
    // 0x is no longer supported, using v2 instead
    // ZEROX = "0x",
    ZEROX_GASLESS = "0x-gasless",
    ZEROX_V2 = "0x-v2",
    // UNISWAPV3 = "uniswap-v3",
    PARASWAP = "paraswap",
    SOCKET = "socket",
    BLOCKEND = "blockend",
    LIFI = "lifi",
    JUPAG = "jupag",
    RANGO = "rango",
    MAYAN = "mayan",
    DLN = "dln",
    ACROSS = "across",
    SQUID = "squid",
    PUMP = "pump",
    VIRTUALS = "virtuals",
    ODOS = "odos",
    LAYERSWAP = "layerswap",
    RELAY = "relay",
    KYBERSWAP = "kyberswap",
    MESON = "meson",
}
export type Asset = {
    networkType: NetworkType;
    chainId: string;
    address: string;
    decimals: number;

    symbol: string;
    name?: string;
    isNative?: boolean;
    isPopular?: boolean;
    image?: string;
    isEnabled: boolean;
    isFlagged: boolean;

    priceId: string;
    coingeckoId: string;
    blockchain: string;
    lastPrice: number;
    marketCap?: number;
    pricingProvider?: string;
    tags?: string[];

    updatedAt?: number;
};

export type Chain = {
    chainId: string;
    symbol: string;
    name: string;
    networkType: NetworkType;

    image: string;
    isPopular?: boolean;
    isEnabled: boolean;
    isFeatured: boolean;

    explorer: {
        token: string; // https://polygonscan.com/token/{tokenAddress}
        txn: string; // https://polygonscan.com/tx/{txnHash}
        address?: string; // https://polygonscan.com/address/{address}
    };
    rpcUrls: string[];
    nativeCurrency: {
        name: string;
        symbol: string;
        decimals: number;
    };
    tokenCount: number;
};
export const enum Status {
    BAD_REQUEST = "bad-request",
    NO_ROUTES = "no-routes",
    NOT_STARTED = "not-started",
    STARTED = "started",
    IN_PROGRESS = "in-progress",
    SUCCESS = "success",
    PARTIAL_SUCCESS = "partial-success",
    FAILED = "failed",
    TXN_EXPIRED = "txn-expired",
    QUOTE_EXPIRED = "quote-expired",
    ERROR = "error",
    CANCELLED = "cancelled",
}
export type TxnMetaData = {
    id?: string; // or can be simple step number
    routeId: string;
    stepId: string;

    isCompleted: boolean;
    deadline?: number;

    networkType: NetworkType;
    txnType: TxnType;
    status?: Status;

    txnHash?: string;
    txnBlock?: string;
    txnStatus?: "success" | "failed";
    srcTxnHash?: string;
    srcTxnUrl?: string;
    destTxnHash?: string;
    destTxnUrl?: string;
    txnData?: any;
    signedTxn?: any;
    gasless?: boolean;

    createdAt: number;
    fetchedAt?: number; // 1st time when txnData is fetched by user (/nextTxn endpoint)
    txnHashUpdatedAt?: number; // 1st time when txnHash is submitted by user (/status check endpoint)
    srcHashConfirmedAt?: number; // time when srcTxnHash is confirmed by BE
    destHashConfirmedAt?: number; // time when destTxnHash is confirmed by BE
    failedAt?: number; // time when txn failed
    nextTxStart?: number; // time when next txn is started
    nextTxEnd?: number; // time when next txn is completed
    statusCheckStart?: number; // time when status check is started
    statusCheckEnd?: number; // time when status check is completed

    exchangeData?: any;
    skipTxn?: boolean;
    points?: number;

    outputAmount?: string;
    outputAmountDisplay?: string;
    outputToken?: Asset;
    warnings?: TxnWarning[];
};

export type TxnData = TxnMetaData & {
    txnEvm?: TxnEvm | TxnEvmGasless;
    txnSol?: TxnSol;
    txnTron?: TxnTron;
    txnCosmos?: TxnCosmos;
};
export const enum TxnWarning {
    OUTPUT_TOKEN_CHANGED = "OUTPUT_TOKEN_CHANGED",
    NO_OUTPUT_AMOUNT = "NO_OUTPUT_AMOUNT",
}
export type TxnEvm = {
    from: string | null;
    to: string;
    value?: string | null;
    data?: string | null;

    gasPrice?: string | null;
    gasLimit?: string | null; // TODO: fix this to string only
};

export type TxnEvmGasless =
    | {
          type: any;
          domain: any;
          message: any;
          primaryType: any;
      }
    | any;

export type TxnSol = {
    data: string;
};

export type TxnTron = {
    raw_data?: any | null;
    raw_data_dex?: string | null;
    txID: string;
    visible: boolean;
};

export type TxnCosmos = {
    data: string;
    value: string;
    gasLimit: string;
    gasPrice: string;
    maxFeePerGas?: string;
};
export const enum FeeType {
    NETWORK = "NETWORK", // gas fee
    PROVIDER = "PROVIDER", // fee charged by the provider
    BLOCKEND = "BLOCKEND", // fee charged by blockend
    INTEGRATOR = "INTEGRATOR", // custom fee someone want to charge via blockend integration
}
export const enum FeeSource {
    FROM_SOURCE_WALLET = "FROM_SOURCE_WALLET",
    FROM_OUTPUT_AMOUNT = "FROM_OUTPUT_AMOUNT",
    FROM_INPUT_AMOUNT = "FROM_INPUT_AMOUNT",
}

export type Fee = {
    type: FeeType;
    token: Asset;
    source: FeeSource;
    amountInToken: string;
    amountInUSD?: number | string; // TODO: rename amountInUSD to amountInUsd
    amountInUsd?: number | string; // TODO: rename amountInUSD to amountInUsd
};
export type StepType = "approval" | "swap" | "bridge" | "sign" | "claim";

export type Steps = {
    stepId: string;
    stepType: StepType;
    protocolsUsed: string[];
    provider?: Providers;

    from: Asset;
    // fromWalletAddress: string;
    to: Asset;
    // toWalletAddress: string;
    txnHash?: string;
    status?: Status;

    inputAmount: string;
    outputAmount: string;
    fee: Fee[];
    subSteps?: Steps[];

    estimatedTimeInSeconds?: number;
    gasless?: boolean;

    exchangeData?: any; // for exchange specific stuff
    warnings?: string[];

    texts?: {
        heading: string;

        preText: string;
        loadingText: string;
        loadingDescription: string;
        postText: string;

        preDescription: string;
        preCta: string;
        processingDescription: string;
        processingCta: string;

        status: {
            pending: string;
            success: string;
            failed: string;
        };
    };

    // everything below is for future reference
    // TODO: future implementation
    // condition checking
    preCondition?: ConditionCheck<ConditionCheckType>[];
    condition?: ConditionCheck<ConditionCheckType>[];
    postCondition?: ConditionCheck<ConditionCheckType>[];
};
export const enum ConditionCheckType {
    BALANCE = "balance",
    APPROVAL = "approval",
    TRANSACTION = "transaction",
}
type ConditionCheckTypeKeys = "balance" | "approval" | "transaction";

export type ConditionCheck<T extends ConditionCheckTypeKeys> =
    T extends "balance"
        ? BalanceConditionCheck
        : T extends "approval"
        ? ApprovalConditionCheck
        : T extends "transaction"
        ? TransactionConditionCheck
        : never;
export type ApprovalConditionCheck = {
    type: ConditionCheckType.APPROVAL;
    asset: Asset;
    targetAddress: string; // needed for allowance
    minAmount: string;
};

export type BalanceConditionCheck = {
    type: ConditionCheckType.BALANCE;
    asset: Asset;
    minAmount: string;
};

export type TransactionConditionCheck = {
    type: ConditionCheckType.TRANSACTION;
    asset: Asset;
    txnHash: string;

    to: string;
    from: string;
    callData: string;
    timestamp: number;
    value?: string;
};
export type ProviderDetails = {
    id: Providers;
    name: string;
    logoUrl: string;

    description?: string;
    websiteUrl?: string;
};
export type Route = {
    requestId?: string;
    routeId: string;

    from: Asset;
    to: Asset;
    steps: Steps[];
    fee: Fee[];

    provider: Providers;
    providerDetails: ProviderDetails;
    protocolsUsed: string[];

    inputAmount: string; // 3.2*10^18
    inputAmountDisplay: string; // 3.2

    outputAmount: string; // 4.56*10^18
    outputAmountDisplay: string; // 4.56
    minOutputAmount: string; // 4.32*10^18
    minOutputAmountDisplay?: string; // 4.32
    slippage: number;

    userWalletAddress: string;
    recipient?: string;

    // time when quote is created (fetched) from provider
    // can also be used for removing old unused quotes
    createdAt: number;
    deadline: number; // deadline (in seconds) for quote to be used
    estimatedTimeInSeconds: number;
    txnCreatedAt?: number; // time when txn is created (/createTxn endpoint)

    gasless?: boolean;
    exchangeData?: any; // for exchange specific stuff
    intent?: QuoteRequest; // for storing users actual intent
    isActive?: boolean; // set when quote is used (create txn)
    status?: Status;
    points?: number;

    tags?: string[];
    score?: any;

    actualOutputAmount?: string;
    actualOutputAmountDisplay?: string;
    actualOutputToken?: Asset;
    outputWarnings?: TxnWarning[];
};
export type QuoteRequest = MetaInfo & {
    fromChainId: string;
    fromAssetAddress: string;
    fromAddress?: string;
    fromAmount?: string;

    toChainId: string;
    toAssetAddress: string;
    toAddress?: string;
    toAmount?: string;

    inputAmountDisplay: string;
    inputAmount: string; // inputAmountDisplay converted to wei, done on BE side
    outputAmount?: string;
    fromAmountForGasDisplay?: string;
    fromAmountForGas?: string;

    userWalletAddress: string;
    recipient?: string;
    slippage: number; // in bps, 100 = 1%
    fixedSlippage?: boolean;
    sortBy: string; // "price" | "speed" | "fee"
    feeBps?: number;

    solanaOptions?: SolanaOptions; // object containing Solana-specific parameters
    evmOptions?: EvmOptions; // object containing Evm-specific parameters
    skipChecks?: boolean;

    gasless?: boolean; // full txn is gasless, i.e. both approval and swap are gasless
    gaslessSwap?: boolean; // only swap is gasless

    // undocumented feature to bypass solana sender and recipient address check (check that they should be same)
    // this would allow to receive output funds on different adddress (token account) then sender' token account
    // catch is that recipient's token account should be created before hand
    // so keeping this undocumented and only using this feature internally
    // this will be used in claim fee module, where we will check if the token account exist on-chain
    allowRecipientOnSol?: string;

    side?: "buy" | "sell";
    createdAt?: number; // time when quotes are fetched by user (/quotes endpoint)
    txnCreatedAt?: number; // time when txn is created (/createTxn endpoint)
    include?: string; // Comma-separated list of providers to include
    exclude?: string; // Comma-separated list of providers to exclude
    recommendedProvider?: boolean; // Flag to indicate if only recommended providers should be used
};
export type MetaInfo = {
    userId?: string; // maps to api user
    projectId?: string; // maps to project id
    apiKeyId?: string; // maps to api key id of an api user
    integratorId?: string; // maps to api user/integration user
    sessionId?: string; // a custom sessionId to identify user session
    trackingId?: string; // custom id that can be passed by api user/widget integrator for their tracking
};
export type PriorityLevel = "low" | "medium" | "high" | "ultra" | "degen";
export type PriorityInput = number | PriorityLevel;

// Model with request data for quote
export type SolanaOptions = {
    priorityFee?: PriorityInput; // Optional priority fee in lamports or priority level
    jitoTip?: PriorityInput; // Optional Jito tip in lamports or priority level
};

export type EvmOptions = {
    priorityFee?: PriorityInput; // Optional priority fee in lamports or priority level
};

export type Config = {
    BLOCKEND_INTEGRATOR_ID?: string;
    WALLET_PRIVATE_KEY?: string;
    WALLET_KEYPAIR?: string;
    SOLANA_RPC_URL?: string;
};
