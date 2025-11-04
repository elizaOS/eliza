/**
 * x402 Payment Types
 * 
 * These types extend the core Route type to support payment protection.
 * Plugin developers can import these from @elizaos/core without needing
 * to depend on @elizaos/server.
 */

import type { Route } from './plugin.js';

/**
 * Network configuration - supports multiple chains
 * Can be extended by plugins to support additional networks
 */
export type Network = string;

/**
 * Payment config definition that plugins can register
 */
export interface PaymentConfigDefinition {
    network: string;
    assetNamespace: string;      // e.g., "erc20", "spl-token", "slip44"
    assetReference: string;       // e.g., contract address or token mint
    paymentAddress: string;       // Recipient address
    symbol: string;               // Display symbol (USDC, ETH, etc.)
    chainId?: string;             // Optional chain ID for CAIP-2 (e.g., "8453" for Base)
}

/**
 * x402 configuration for routes
 */
export interface X402Config {
    priceInCents: number;
    paymentConfigs?: string[];  // Named configs, defaults to ['base_usdc']
}

/**
 * Validation result for pre-payment parameter validation
 */
export interface X402ValidationResult {
    valid: boolean;
    error?: {
        status: number;
        message: string;
        details?: any;
    };
}

/**
 * Validator function that checks request parameters before payment
 * Returns validation result indicating if request is valid
 */
export type X402RequestValidator = (req: any) => X402ValidationResult | Promise<X402ValidationResult>;

/**
 * OpenAPI parameter definition
 */
export interface X402OpenAPIParameter {
    name: string;
    in: 'path' | 'query' | 'header';
    required?: boolean;
    description?: string;
    schema: {
        type: string;
        format?: string;
        pattern?: string;
        enum?: string[];
        minimum?: number;
        maximum?: number;
    };
}

/**
 * OpenAPI request body definition
 */
export interface X402OpenAPIRequestBody {
    required?: boolean;
    description?: string;
    content: {
        'application/json'?: { schema: any };
        'multipart/form-data'?: { schema: any };
    };
}

/**
 * Extended Route interface to include payment properties
 * Plugin developers can use this type when defining paid routes
 * 
 * @example
 * ```typescript
 * import type { PaymentEnabledRoute } from '@elizaos/core';
 * 
 * const routes: PaymentEnabledRoute[] = [{
 *   type: 'GET',
 *   path: '/api/premium-data',
 *   x402: {
 *     priceInCents: 10,
 *     paymentConfigs: ['base_usdc']
 *   },
 *   handler: async (req, res, runtime) => {
 *     // Your handler logic
 *   }
 * }];
 * ```
 */
export interface PaymentEnabledRoute extends Route {
    x402?: X402Config;
    description?: string;
    openapi?: {
        parameters?: X402OpenAPIParameter[];
        requestBody?: X402OpenAPIRequestBody;
    };
    validator?: X402RequestValidator;
}

