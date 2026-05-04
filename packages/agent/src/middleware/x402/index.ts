/**
 * x402 Payment Middleware for ElizaOS
 *
 * Provides micropayment protection for plugin routes using the x402 protocol.
 *
 * **Why this module exists (product):** plugin authors should declare `x402` on
 * routes and get a consistent gate—402 with payment options, verification, and
 * optional facilitator settlement—without reimplementing payment math, replay
 * safety, or HTTP header quirks in every plugin.
 *
 * **Why both “legacy JSON 402” and V2 headers:** older clients and scanners read
 * the JSON body; protocol V2 buyers read `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`.
 * Serving both avoids breaking existing integrations while still interoperating
 * with modern wallets.
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

export type {
  BuiltInPaymentConfig,
  CharacterX402Settings,
  PaymentEnabledRoute,
  X402Config,
  X402RequestValidator,
  X402ValidationResult,
} from "@elizaos/core";

export type { Network } from "./payment-config.ts";
export {
  atomicAmountForPriceInCents,
  BUILT_IN_NETWORKS,
  getBaseUrl,
  getPaymentAddress,
  getPaymentConfig,
  getX402Health,
  listX402Configs,
  PAYMENT_ADDRESSES,
  PAYMENT_CONFIGS,
  type PaymentConfigDefinition,
  registerX402Config,
  toResourceUrl,
  toX402Network,
} from "./payment-config.ts";
export {
  applyPaymentProtection,
  createPaymentAwareHandler,
  isRoutePaymentWrapped,
  X402_ROUTE_PAYMENT_WRAPPED,
} from "./payment-wrapper.ts";
export {
  resolveEffectiveX402,
  X402_EVENT_PAYMENT_REQUIRED,
  X402_EVENT_PAYMENT_VERIFIED,
} from "./x402-resolve.ts";

export {
  type Accepts,
  createAccepts,
  createX402Response,
  type OutputSchema,
  validateAccepts,
  validateX402Response,
  type X402Response,
  type X402ScanNetwork,
} from "./x402-types.ts";
