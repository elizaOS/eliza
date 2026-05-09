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
 * import { applyPaymentProtection } from '@elizaos/plugin-x402';
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

export type { Network } from "./payment-config.js";
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
} from "./payment-config.js";
export {
  applyPaymentProtection,
  createPaymentAwareHandler,
  isRoutePaymentWrapped,
  X402_ROUTE_PAYMENT_WRAPPED,
} from "./payment-wrapper.js";
export {
  resolveEffectiveX402,
  X402_EVENT_PAYMENT_REQUIRED,
  X402_EVENT_PAYMENT_VERIFIED,
} from "./x402-resolve.js";
export {
  type StartupValidationResult,
  validateAndThrowIfInvalid,
  validateX402Startup,
} from "./startup-validator.js";

export {
  type Accepts,
  createAccepts,
  createX402Response,
  type OutputSchema,
  validateAccepts,
  validateX402Response,
  type X402Response,
  type X402ScanNetwork,
} from "./x402-types.js";

import type { Plugin } from "@elizaos/core";

/**
 * elizaOS plugin descriptor for x402.
 *
 * The middleware exported above is the actual integration surface — plugins
 * declare `x402` on their routes and the agent's HTTP dispatch wraps them via
 * `applyPaymentProtection` / `createPaymentAwareHandler`. This Plugin object
 * exists so the runtime's plugin loader can register `@elizaos/plugin-x402` as
 * a first-class auto-loadable plugin (config: `x402.enabled`).
 */
const x402Plugin: Plugin = {
  name: "x402",
  description:
    "x402 micropayment middleware for elizaOS plugin HTTP routes (HTTP 402 / payment-required).",
  actions: [],
  providers: [],
  evaluators: [],
  services: [],
};

export default x402Plugin;
export { x402Plugin };
