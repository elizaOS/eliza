/**
 * Contract consumed from the optional x402 plugin. Keeping this interface in
 * the host avoids an ambient declaration for a package that may be absent and
 * gives every dynamic-loader boundary one versioned shape to validate.
 */
import type {
  LegacyRouteHandler,
  PaymentEnabledRoute,
  Route,
} from "@elizaos/host/protocol";
export interface X402PluginModule {
  __mobileStub?: boolean;
  createPaymentAwareHandler(route: PaymentEnabledRoute): LegacyRouteHandler;
  isRoutePaymentWrapped(route: unknown): boolean;
  validateX402Startup?(
    routes: Route[],
    character: unknown,
    options: {
      agentId?: string;
    },
  ): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
}

/**
 * Vet a resolved `@elizaos/plugin-x402` module: return it only when it exposes
 * usable payment helpers, otherwise `null`. The mobile bundle aliases the
 * plugin to a null stub whose exports are no-op proxies (flagged
 * `__mobileStub`), so `createPaymentAwareHandler` would return `undefined`.
 */
function vetX402Module(mod: unknown): X402PluginModule | null {
  if (mod == null) return null;
  if ((mod as { __mobileStub?: boolean }).__mobileStub) return null;
  const candidate = mod as Partial<X402PluginModule>;
  if (
    typeof candidate.createPaymentAwareHandler !== "function" ||
    typeof candidate.isRoutePaymentWrapped !== "function"
  ) {
    return null;
  }
  return candidate as X402PluginModule;
}

let x402PaymentModule: X402PluginModule | null = null;
let x402PaymentModulePromise: Promise<X402PluginModule | null> | null = null;

/**
 * Load the optional payment plugin for route dispatch. `null` means payment
 * cannot be enforced in this process (package not installed, or mobile stub).
 * Every route dispatcher must then refuse an x402-declared route with
 * {@link X402_ENFORCEMENT_UNAVAILABLE}; a paid route is never served unpaid.
 */
export function loadX402PaymentModule(): Promise<X402PluginModule | null> {
  if (x402PaymentModule) return Promise.resolve(x402PaymentModule);
  // Variable specifier keeps Vite's import-analysis from eagerly resolving the
  // optional plugin's dist (which is absent in the unit lane / mobile bundle).
  const specifier = "@elizaos/plugin-x402";
  x402PaymentModulePromise ??= import(/* @vite-ignore */ specifier)
    .then((mod) => {
      const vetted = vetX402Module(mod);
      if (vetted) x402PaymentModule = vetted;
      return vetted;
    })
    .catch(() => null);
  return x402PaymentModulePromise;
}

/** Response every dispatcher returns for a paid route it cannot gate. */
export const X402_ENFORCEMENT_UNAVAILABLE = {
  status: 503,
  body: {
    error:
      "This route requires x402 payment, but payment enforcement is unavailable on this host.",
    code: "X402_ENFORCEMENT_UNAVAILABLE",
  },
} as const;
