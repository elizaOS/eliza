/**
 * x402 Payment Middleware for ElizaOS
 * 
 * Provides micropayment protection for plugin routes using the x402 protocol.
 * 
 * @example
 * ```typescript
 * import { applyPaymentProtection } from './middleware/x402';
 * 
 * // In your plugin:
 * export const routes: Route[] = [
 *   {
 *     type: 'GET',
 *     path: '/api/analytics/trending',
 *     public: true,
 *     x402: {
 *       priceInCents: 10,
 *       paymentConfigs: ['base_usdc', 'solana_usdc']
 *     },
 *     handler: async (req, res, runtime) => {
 *       // Your handler logic
 *     }
 *   }
 * ];
 * ```
 */

// Re-export types from @elizaos/core so they're available from both packages
export type {
    PaymentEnabledRoute,
    X402Config,
    Network,
    X402ValidationResult,
    X402RequestValidator
} from '@elizaos/core';

export {
    applyPaymentProtection,
    createPaymentAwareHandler
} from './payment-wrapper.js';

export {
    type PaymentConfigDefinition,
    PAYMENT_CONFIGS,
    PAYMENT_ADDRESSES,
    BUILT_IN_NETWORKS,
    registerX402Config,
    getPaymentConfig,
    getPaymentAddress,
    listX402Configs,
    toX402Network,
    toResourceUrl,
    getBaseUrl,
    getX402Health
} from './payment-config.js';

export {
    type X402Response,
    type Accepts,
    type OutputSchema,
    type X402ScanNetwork,
    createX402Response,
    createAccepts,
    validateX402Response,
    validateAccepts
} from './x402-types.js';

