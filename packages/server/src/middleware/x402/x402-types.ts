/**
 * x402scan Validation Schema Types
 * Stricter schema required for listing on x402scan
 * Allows UI-based resource invocation
 */

/**
 * Field definition for input/output schema
 */
export type FieldDef = {
    type?: string;
    required?: boolean | string[];
    description?: string;
    enum?: string[];
    properties?: Record<string, FieldDef>; // for nested objects
};

/**
 * Output schema describing input and output expectations for the paid endpoint
 */
export type OutputSchema = {
    input: {
        type: "http";
        method: "GET" | "POST";
        bodyType?: "json" | "form-data" | "multipart-form-data" | "text" | "binary";
        pathParams?: Record<string, FieldDef>;
        queryParams?: Record<string, FieldDef>;
        bodyFields?: Record<string, FieldDef>;
        headerFields?: Record<string, FieldDef>;
    };
    output?: Record<string, any>;
};

/**
 * Valid x402scan network types (as per their API specification)
 */
export type X402ScanNetwork =
    | 'base-sepolia'
    | 'base'
    | 'avalanche-fuji'
    | 'avalanche'
    | 'iotex'
    | 'solana-devnet'
    | 'solana'
    | 'sei'
    | 'sei-testnet'
    | 'polygon'
    | 'polygon-amoy'
    | 'peaq';

/**
 * Accepts object defining payment terms for a resource
 */
export type Accepts = {
    scheme: "exact";
    network: X402ScanNetwork;
    maxAmountRequired: string;
    resource: string; // Must be a full URL (https://...)
    description: string;
    mimeType: string;
    payTo: string; // Wallet address - must be valid for the network
    maxTimeoutSeconds: number;
    asset: string;

    // Optional schema describing the input and output expectations
    outputSchema?: OutputSchema;

    // Optional additional custom data
    extra?: Record<string, any>;
};

/**
 * X402 Response structure
 */
export type X402Response = {
    x402Version: number;
    error?: string;
    accepts?: Array<Accepts>;
    payer?: string;
};

/**
 * Validation result type
 */
export type ValidationResult = {
    valid: boolean;
    errors: string[];
};

/**
 * Valid x402scan networks
 */
const VALID_NETWORKS: X402ScanNetwork[] = [
    'base-sepolia', 'base', 'avalanche-fuji', 'avalanche', 'iotex',
    'solana-devnet', 'solana', 'sei', 'sei-testnet', 'polygon', 'polygon-amoy', 'peaq'
];

/**
 * Validate URL format
 */
function isValidUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Validate wallet address format based on network
 */
function isValidWalletAddress(address: string, network: X402ScanNetwork): boolean {
    if (!address || typeof address !== 'string') return false;

    // Solana addresses are base58 encoded, typically 32-44 characters
    if (network.includes('solana')) {
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    }

    // EVM-compatible chains use 0x addresses
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate that an Accepts object conforms to the x402scan schema
 */
export function validateAccepts(accepts: Partial<Accepts>): ValidationResult {
    const errors: string[] = [];

    // Required fields
    if (accepts.scheme !== "exact") {
        errors.push('scheme must be "exact"');
    }

    if (!accepts.network || !VALID_NETWORKS.includes(accepts.network as X402ScanNetwork)) {
        errors.push(`network must be one of: ${VALID_NETWORKS.join(', ')}`);
    }

    if (!accepts.maxAmountRequired || typeof accepts.maxAmountRequired !== 'string') {
        errors.push('maxAmountRequired is required and must be a string');
    }

    if (!accepts.resource || typeof accepts.resource !== 'string') {
        errors.push('resource is required and must be a string (full URL)');
    } else if (!isValidUrl(accepts.resource)) {
        errors.push('resource must be a valid URL (must start with http:// or https://)');
    }

    if (!accepts.description || typeof accepts.description !== 'string') {
        errors.push('description is required and must be a string');
    }

    if (!accepts.mimeType || typeof accepts.mimeType !== 'string') {
        errors.push('mimeType is required and must be a string (e.g., "application/json")');
    }

    if (!accepts.payTo || typeof accepts.payTo !== 'string') {
        errors.push('payTo is required and must be a string (wallet address)');
    } else if (accepts.network && !isValidWalletAddress(accepts.payTo, accepts.network as X402ScanNetwork)) {
        errors.push(`payTo must be a valid wallet address for network ${accepts.network}`);
    }

    if (!accepts.maxTimeoutSeconds || typeof accepts.maxTimeoutSeconds !== 'number') {
        errors.push('maxTimeoutSeconds is required and must be a number');
    }

    if (!accepts.asset || typeof accepts.asset !== 'string') {
        errors.push('asset is required and must be a string (e.g., "USDC", "ETH")');
    }

    // Validate outputSchema if present
    if (accepts.outputSchema) {
        const schema = accepts.outputSchema;

        if (!schema.input || schema.input.type !== "http") {
            errors.push('outputSchema.input.type must be "http"');
        }

        if (!schema.input.method || !["GET", "POST"].includes(schema.input.method)) {
            errors.push('outputSchema.input.method must be "GET" or "POST"');
        }

        if (schema.input.bodyType) {
            const validBodyTypes = ["json", "form-data", "multipart-form-data", "text", "binary"];
            if (!validBodyTypes.includes(schema.input.bodyType)) {
                errors.push(`outputSchema.input.bodyType must be one of: ${validBodyTypes.join(", ")}`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validate that an X402Response conforms to the x402scan schema
 */
export function validateX402Response(response: Partial<X402Response>): ValidationResult {
    const errors: string[] = [];

    // x402Version is required
    if (typeof response.x402Version !== 'number') {
        errors.push('x402Version is required and must be a number');
    }

    // If accepts is provided, validate each entry
    if (response.accepts) {
        if (!Array.isArray(response.accepts)) {
            errors.push('accepts must be an array');
        } else {
            response.accepts.forEach((accepts, index) => {
                const validation = validateAccepts(accepts);
                if (!validation.valid) {
                    errors.push(`accepts[${index}]: ${validation.errors.join(', ')}`);
                }
            });
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Create a validated Accepts object with sensible defaults
 */
export function createAccepts(params: {
    network: X402ScanNetwork;
    maxAmountRequired: string;
    resource: string;
    description: string;
    payTo: string;
    asset: string;
    mimeType?: string;
    maxTimeoutSeconds?: number;
    outputSchema?: OutputSchema;
    extra?: Record<string, any>;
}): Accepts {
    const accepts: Accepts = {
        scheme: "exact",
        network: params.network,
        maxAmountRequired: params.maxAmountRequired,
        resource: params.resource,
        description: params.description,
        mimeType: params.mimeType || "application/json",
        payTo: params.payTo,
        maxTimeoutSeconds: params.maxTimeoutSeconds || 300, // 5 minutes default
        asset: params.asset,
    };

    if (params.outputSchema) {
        accepts.outputSchema = params.outputSchema;
    }

    if (params.extra) {
        accepts.extra = params.extra;
    }

    // Validate before returning
    const validation = validateAccepts(accepts);
    if (!validation.valid) {
        throw new Error(`Invalid Accepts object: ${validation.errors.join(', ')}`);
    }

    return accepts;
}

/**
 * Create a validated X402Response
 */
export function createX402Response(params: {
    accepts?: Accepts[];
    error?: string;
    payer?: string;
}): X402Response {
    const response: X402Response = {
        x402Version: 1,
        ...params
    };

    // Validate before returning
    const validation = validateX402Response(response);
    if (!validation.valid) {
        throw new Error(`Invalid X402Response: ${validation.errors.join(', ')}`);
    }

    return response;
}

