/**
 * Startup validation for x402 payment system
 * Validates payment configs and routes before the server starts
 */

import type { Route } from '@elizaos/core';
import type { PaymentEnabledRoute } from './payment-wrapper.js';
import { 
    getPaymentConfig, 
    listX402Configs, 
    BUILT_IN_NETWORKS,
    getX402Health,
    type Network 
} from './payment-config.js';

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
function validatePaymentConfig(configName: string): { errors: string[], warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
        const config = getPaymentConfig(configName);

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
            errors.push(`Config '${configName}': missing 'paymentAddress' (wallet address required)`);
        }
        if (!config.symbol) {
            errors.push(`Config '${configName}': missing 'symbol'`);
        }

        // Validate address format
        if (config.paymentAddress) {
            // Solana addresses: base58, 32-44 chars
            if (config.network === 'SOLANA') {
                if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.paymentAddress)) {
                    errors.push(`Config '${configName}': invalid Solana address format`);
                }
            }
            // EVM addresses: 0x + 40 hex chars
            else if (config.network === 'BASE' || config.network === 'POLYGON' || config.assetNamespace === 'erc20') {
                if (!/^0x[a-fA-F0-9]{40}$/.test(config.paymentAddress)) {
                    errors.push(`Config '${configName}': invalid EVM address format (should be 0x...)`);
                }
            }

            // Check if address looks like default/example
            if (config.paymentAddress === '0x0000000000000000000000000000000000000000') {
                warnings.push(`Config '${configName}': using zero address (0x0...0) - is this intentional?`);
            }
        }

        // Validate asset reference (contract address / token mint)
        if (config.assetReference && config.assetNamespace === 'erc20') {
            if (!/^0x[a-fA-F0-9]{40}$/.test(config.assetReference)) {
                errors.push(`Config '${configName}': invalid ERC20 token address format`);
            }
        }

        // Check if network is built-in (warn if custom)
        if (!BUILT_IN_NETWORKS.includes(config.network as any)) {
            warnings.push(
                `Config '${configName}': using custom network '${config.network}' ` +
                `(not in built-in networks: ${BUILT_IN_NETWORKS.join(', ')})`
            );
        }

    } catch (error) {
        errors.push(`Config '${configName}': ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    return { errors, warnings };
}

/**
 * Validate an x402 route configuration
 */
function validateX402Route(route: Route): { errors: string[], warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const x402Route = route as PaymentEnabledRoute;

    if (!route.path) {
        errors.push(`Route missing 'path' property`);
        return { errors, warnings };
    }

    const routePath = route.path;

    // If no x402 config, nothing to validate
    if (!x402Route.x402) {
        return { errors, warnings };
    }

    // Validate price
    if (x402Route.x402.priceInCents === undefined || x402Route.x402.priceInCents === null) {
        errors.push(`${routePath}: x402.priceInCents is required`);
    } else if (typeof x402Route.x402.priceInCents !== 'number') {
        errors.push(`${routePath}: x402.priceInCents must be a number`);
    } else if (x402Route.x402.priceInCents <= 0) {
        errors.push(`${routePath}: x402.priceInCents must be > 0`);
    } else if (!Number.isInteger(x402Route.x402.priceInCents)) {
        errors.push(`${routePath}: x402.priceInCents must be an integer`);
    }

    // Warn if price is very high
    if (x402Route.x402.priceInCents && x402Route.x402.priceInCents > 10000) { // > $100
        warnings.push(`${routePath}: price is $${(x402Route.x402.priceInCents / 100).toFixed(2)} - is this intentional?`);
    }

    // Warn if price is very low
    if (x402Route.x402.priceInCents && x402Route.x402.priceInCents < 1) { // < $0.01
        warnings.push(`${routePath}: price is less than $0.01 - micropayment too small?`);
    }

    // Validate payment configs
    const configs = x402Route.x402.paymentConfigs || ['base_usdc'];
    if (!Array.isArray(configs)) {
        errors.push(`${routePath}: x402.paymentConfigs must be an array`);
    } else {
        if (configs.length === 0) {
            errors.push(`${routePath}: x402.paymentConfigs cannot be empty`);
        }

        // Get all available configs (built-in + custom registered)
        const availableConfigs = listX402Configs();

        for (const configName of configs) {
            if (typeof configName !== 'string') {
                errors.push(`${routePath}: x402.paymentConfigs contains non-string value`);
            } else if (!availableConfigs.includes(configName)) {
                errors.push(
                    `${routePath}: unknown payment config '${configName}'. ` +
                    `Available: ${availableConfigs.join(', ')}`
                );
            } else {
                // Validate the config itself
                const configValidation = validatePaymentConfig(configName);
                errors.push(...configValidation.errors.map(e => `${routePath}: ${e}`));
                warnings.push(...configValidation.warnings.map(w => `${routePath}: ${w}`));
            }
        }
    }

    // Validate route handler exists
    if (!route.handler) {
        errors.push(`${routePath}: route has x402 protection but no handler function`);
    }

    return { errors, warnings };
}

/**
 * Validate environment configuration
 */
function validateEnvironment(): { errors: string[], warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check network configuration
    const health = getX402Health();
    
    for (const network of health.networks) {
        if (!network.configured || !network.address) {
            warnings.push(
                `Network '${network.network}' not configured. ` +
                `Set ${network.network}_PUBLIC_KEY in .env to accept payments on this network.`
            );
        }
    }

    // Check facilitator configuration (optional)
    if (!health.facilitator.configured) {
        warnings.push(
            'X402_FACILITATOR_URL not set. Direct blockchain verification will be used. ' +
            'Consider setting up a facilitator for better UX.'
        );
    }

    return { errors, warnings };
}

/**
 * Comprehensive startup validation
 * Call this before starting the server to catch configuration issues early
 */
export function validateX402Startup(routes: Route[]): StartupValidationResult {
    const allErrors: string[] = [];
    const allWarnings: string[] = [];

    console.log('\n🔍 Validating x402 payment configuration...\n');

    // 1. Validate environment
    const envValidation = validateEnvironment();
    allErrors.push(...envValidation.errors);
    allWarnings.push(...envValidation.warnings);

    // 2. Validate all routes
    let protectedRouteCount = 0;
    for (const route of routes) {
        const x402Route = route as PaymentEnabledRoute;
        if (x402Route.x402) {
            protectedRouteCount++;
            const routeValidation = validateX402Route(route);
            allErrors.push(...routeValidation.errors);
            allWarnings.push(...routeValidation.warnings);
        }
    }

    // 3. Summary
    console.log(`📊 Validation Summary:`);
    console.log(`   • Total routes: ${routes.length}`);
    console.log(`   • Protected routes: ${protectedRouteCount}`);
    console.log(`   • Payment configs: ${listX402Configs().length}`);
    
    if (allErrors.length > 0) {
        console.log(`   • ❌ Errors: ${allErrors.length}`);
    } else {
        console.log(`   • ✅ Errors: 0`);
    }
    
    if (allWarnings.length > 0) {
        console.log(`   • ⚠️  Warnings: ${allWarnings.length}`);
    } else {
        console.log(`   • ✅ Warnings: 0`);
    }

    // 4. Display errors
    if (allErrors.length > 0) {
        console.log(`\n❌ Configuration Errors:\n`);
        for (const error of allErrors) {
            console.log(`   • ${error}`);
        }
    }

    // 5. Display warnings
    if (allWarnings.length > 0) {
        console.log(`\n⚠️  Warnings:\n`);
        for (const warning of allWarnings) {
            console.log(`   • ${warning}`);
        }
    }

    if (allErrors.length === 0 && allWarnings.length === 0) {
        console.log(`\n✅ All x402 configurations are valid!\n`);
    } else if (allErrors.length === 0) {
        console.log(`\n✅ No errors found (warnings can be ignored if intentional)\n`);
    } else {
        console.log(`\n❌ Please fix the errors above before starting the server.\n`);
    }

    return {
        valid: allErrors.length === 0,
        errors: allErrors,
        warnings: allWarnings
    };
}

/**
 * Validate routes and throw if invalid
 * This is used by applyPaymentProtection to fail fast on startup
 */
export function validateAndThrowIfInvalid(routes: Route[]): void {
    const result = validateX402Startup(routes);
    
    if (!result.valid) {
        throw new Error(
            `x402 Configuration Invalid (${result.errors.length} error${result.errors.length > 1 ? 's' : ''}):\n\n` +
            result.errors.map(e => `  • ${e}`).join('\n') +
            '\n\nPlease fix these errors and try again.'
        );
    }
}

