/**
 * Contract consumed from the optional x402 plugin. Keeping this interface in
 * the host avoids an ambient declaration for a package that may be absent and
 * gives every dynamic-loader boundary one versioned shape to validate.
 */
import type {
  LegacyRouteHandler,
  PaymentEnabledRoute,
  Route,
} from "@elizaos/core";

export interface X402PluginModule {
  __mobileStub?: boolean;
  createPaymentAwareHandler(route: PaymentEnabledRoute): LegacyRouteHandler;
  isRoutePaymentWrapped(route: unknown): boolean;
  validateX402Startup?(
    routes: Route[],
    character: unknown,
    options: { agentId?: string },
  ): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
}
