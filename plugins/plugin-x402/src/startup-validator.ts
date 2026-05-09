/**
 * Startup validation for x402 payment system
 * Validates payment configs and routes before the server starts
 */

import type {
  Character,
  CharacterX402Settings,
  PaymentEnabledRoute,
  Route,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  BUILT_IN_NETWORKS,
  getPaymentConfig,
  getX402Health,
  listX402Configs,
  paymentAddressIsBundledExample,
} from "./payment-config.js";

/**
 * Validation result with warnings and errors
 */
export interface StartupValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a payment config is properly configured
 */
function validatePaymentConfig(
  configName: string,
  agentId?: string,
): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const config = getPaymentConfig(configName, agentId);

    // Check required fields
    if (!config.network) {
      errors.push(`Config '${configName}': missing 'network'`);
    }
    if (!config.assetNamespace) {
      errors.push(`Config '${configName}': missing 'assetNamespace'`);
    }
    if (!config.assetReference) {
      errors.push(`Config '${configName}': missing 'assetReference'`);
    }
    if (!config.paymentAddress) {
      errors.push(
        `Config '${configName}': missing 'paymentAddress' (wallet address required)`,
      );
    }
    if (!config.symbol) {
      errors.push(`Config '${configName}': missing 'symbol'`);
    }

    // Validate address format
    if (config.paymentAddress) {
      // Solana addresses: base58, 32-44 chars
      if (config.network === "SOLANA") {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.paymentAddress)) {
          errors.push(`Config '${configName}': invalid Solana address format`);
        }
      }
      // EVM addresses: 0x + 40 hex chars
      else if (
        config.network === "BASE" ||
        config.network === "POLYGON" ||
        config.assetNamespace === "erc20"
      ) {
        if (!/^0x[a-fA-F0-9]{40}$/.test(config.paymentAddress)) {
          errors.push(
            `Config '${configName}': invalid EVM address format (should be 0x...)`,
          );
        }
      }

      // Check if address looks like default/example
      if (
        config.paymentAddress === "0x0000000000000000000000000000000000000000"
      ) {
        warnings.push(
          `Config '${configName}': using zero address (0x0...0) - is this intentional?`,
        );
      }
    }

    // Validate asset reference (contract address / token mint)
    if (config.assetReference && config.assetNamespace === "erc20") {
      if (!/^0x[a-fA-F0-9]{40}$/.test(config.assetReference)) {
        errors.push(
          `Config '${configName}': invalid ERC20 token address format`,
        );
      }
    }

    if (paymentAddressIsBundledExample(config.network, config.paymentAddress)) {
      if (process.env.NODE_ENV === "production") {
        errors.push(
          `Config '${configName}': paymentAddress is the bundled dev example for ${config.network}. Set ${config.network}_PUBLIC_KEY or PAYMENT_WALLET_${config.network} to your payout wallet before production.`,
        );
      } else {
        warnings.push(
          `Config '${configName}': paymentAddress matches the bundled dev example for ${config.network} — set env payout keys for real settlement.`,
        );
      }
    }

    // Check if network is built-in (warn if custom)
    if (
      !(BUILT_IN_NETWORKS as readonly string[]).includes(
        config.network as string,
      )
    ) {
      warnings.push(
        `Config '${configName}': using custom network '${config.network}' ` +
          `(not in built-in networks: ${BUILT_IN_NETWORKS.join(", ")})`,
      );
    }
  } catch (error) {
    errors.push(
      `Config '${configName}': ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  return { errors, warnings };
}

/**
 * Validate an x402 route configuration
 */
function validateX402Route(
  route: Route,
  character?: Character,
  agentId?: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const x402Route = route as PaymentEnabledRoute;

  if (!route.path) {
    errors.push(`Route missing 'path' property`);
    return { errors, warnings };
  }

  const routePath = route.path;

  if (x402Route.x402 == null) {
    return { errors, warnings };
  }

  const cx = character?.settings?.x402 as CharacterX402Settings | undefined;
  const raw = x402Route.x402;
  let priceInCents: number | undefined;
  let paymentConfigs: string[] | undefined;

  if (raw === true) {
    priceInCents = cx?.defaultPriceInCents;
    paymentConfigs = cx?.defaultPaymentConfigs as string[] | undefined;
    if (priceInCents == null) {
      errors.push(
        `${routePath}: x402: true requires character.settings.x402.defaultPriceInCents`,
      );
    }
    if (!paymentConfigs?.length) {
      errors.push(
        `${routePath}: x402: true requires character.settings.x402.defaultPaymentConfigs (non-empty array)`,
      );
    }
  } else if (typeof raw === "object") {
    priceInCents = raw.priceInCents ?? cx?.defaultPriceInCents;
    paymentConfigs = (raw.paymentConfigs ?? cx?.defaultPaymentConfigs) as
      | string[]
      | undefined;
    if (priceInCents == null) {
      errors.push(
        `${routePath}: x402.priceInCents is required (or set character.settings.x402.defaultPriceInCents)`,
      );
    }
    if (!paymentConfigs?.length) {
      errors.push(
        `${routePath}: x402.paymentConfigs is required (or set character.settings.x402.defaultPaymentConfigs)`,
      );
    }
  }

  if (priceInCents !== undefined && priceInCents !== null) {
    if (typeof priceInCents !== "number") {
      errors.push(`${routePath}: resolved x402.priceInCents must be a number`);
    } else if (priceInCents <= 0) {
      errors.push(`${routePath}: x402.priceInCents must be > 0`);
    } else if (!Number.isInteger(priceInCents)) {
      errors.push(`${routePath}: x402.priceInCents must be an integer (cents)`);
    } else if (priceInCents > 10000) {
      warnings.push(
        `${routePath}: price is $${(priceInCents / 100).toFixed(2)} — is this intentional?`,
      );
    }
  }

  if (paymentConfigs && !Array.isArray(paymentConfigs)) {
    errors.push(`${routePath}: x402.paymentConfigs must be an array`);
  } else if (paymentConfigs?.length === 0) {
    errors.push(`${routePath}: x402.paymentConfigs cannot be empty`);
  } else if (paymentConfigs?.length) {
    const availableConfigs = listX402Configs(agentId);
    for (const configName of paymentConfigs) {
      if (typeof configName !== "string") {
        errors.push(
          `${routePath}: x402.paymentConfigs contains non-string value`,
        );
      } else if (!availableConfigs.includes(configName)) {
        errors.push(
          `${routePath}: unknown payment config '${configName}'. Available: ${availableConfigs.join(", ")}`,
        );
      } else {
        const configValidation = validatePaymentConfig(configName, agentId);
        errors.push(
          ...configValidation.errors.map((e) => `${routePath}: ${e}`),
        );
        warnings.push(
          ...configValidation.warnings.map((w) => `${routePath}: ${w}`),
        );
      }
    }
  }

  if (!route.handler) {
    errors.push(
      `${routePath}: route has x402 protection but no handler function`,
    );
  }

  return { errors, warnings };
}

/**
 * Validate environment configuration
 */
function validateEnvironment(): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check network configuration
  const health = getX402Health();

  for (const network of health.networks) {
    if (!network.configured || !network.address) {
      warnings.push(
        `Network '${network.network}' not configured. ` +
          `Set ${network.network}_PUBLIC_KEY in .env to accept payments on this network.`,
      );
    }
  }

  // Check facilitator configuration (optional)
  if (!health.facilitator.configured) {
    warnings.push(
      "X402_FACILITATOR_URL not set. Direct blockchain verification will be used. " +
        "Consider setting up a facilitator for better UX.",
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    (process.env.X402_TEST_MODE === "true" ||
      process.env.X402_TEST_MODE === "1")
  ) {
    warnings.push(
      "X402_TEST_MODE is set while NODE_ENV=production — clients can bypass payment verification; unset X402_TEST_MODE in production.",
    );
  }

  return { errors, warnings };
}

/**
 * Comprehensive startup validation
 * Call this before starting the server to catch configuration issues early
 */
export function validateX402Startup(
  routes: Route[],
  character?: Character,
  options?: { agentId?: string },
): StartupValidationResult {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  let protectedRouteCount = 0;
  for (const route of routes) {
    const x402Route = route as PaymentEnabledRoute;
    if (x402Route.x402 != null) {
      protectedRouteCount++;
      const routeValidation = validateX402Route(
        route,
        character,
        options?.agentId,
      );
      allErrors.push(...routeValidation.errors);
      allWarnings.push(...routeValidation.warnings);
    }
  }

  if (protectedRouteCount > 0) {
    const envValidation = validateEnvironment();
    allErrors.push(...envValidation.errors);
    allWarnings.push(...envValidation.warnings);

    logger.info(
      `[x402] validated ${protectedRouteCount}/${routes.length} protected route(s); ` +
        `configs=${listX402Configs(options?.agentId).length}, ` +
        `errors=${allErrors.length}, warnings=${allWarnings.length}`,
    );
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

/**
 * Validate routes and throw if invalid
 * This is used by applyPaymentProtection to fail fast on startup
 */
export function validateAndThrowIfInvalid(
  routes: Route[],
  character?: Character,
  options?: { agentId?: string },
): void {
  const result = validateX402Startup(routes, character, options);

  if (!result.valid) {
    throw new Error(
      `x402 Configuration Invalid (${result.errors.length} error${result.errors.length > 1 ? "s" : ""}):\n\n` +
        result.errors.map((e) => `  • ${e}`).join("\n") +
        "\n\nPlease fix these errors and try again.",
    );
  }
}
