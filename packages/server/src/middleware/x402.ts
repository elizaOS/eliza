import { type Request, type Response, type NextFunction } from 'express';
import { logger } from '@elizaos/core';
import { paymentMiddleware, type Network } from 'x402-express';
import { facilitator } from '@coinbase/x402';

/**
 * x402 Payment Middleware Configuration
 *
 * Enables crypto payment requirements for API endpoints using the x402 protocol.
 * Configure via environment variables:
 *
 * Required (if X402_ENABLED is true):
 * - X402_WALLET_ADDRESS: Your receiving wallet address (EVM-compatible)
 *
 * Optional:
 * - X402_ENABLED: Set to "true" to enable payment middleware (default: false)
 * - X402_PRICE: Price in USDC, e.g., "$0.001" (default: "$0.01")
 * - X402_NETWORK: Network to use - "base-sepolia" for testnet, "base" for mainnet (default: "base-sepolia")
 * - X402_FACILITATOR_URL: Facilitator URL (default: "https://x402.org/facilitator" for testnet)
 * - X402_USE_MAINNET: Set to "true" to use CDP facilitator for mainnet (requires CDP_API_KEY_ID and CDP_API_KEY_SECRET)
 *
 * For mainnet (when X402_USE_MAINNET is true):
 * - CDP_API_KEY_ID: Your Coinbase Developer Platform API key ID
 * - CDP_API_KEY_SECRET: Your Coinbase Developer Platform API key secret
 *
 * @see https://docs.cdp.coinbase.com/x402/quickstart-for-sellers
 */

interface X402Config {
  enabled: boolean;
  walletAddress: string | undefined;
  price: string;
  network: Network;
  facilitatorUrl: string;
  useMainnet: boolean;
}

/**
 * Get x402 configuration from environment variables
 */
function getX402Config(): X402Config {
  return {
    enabled: process.env.X402_ENABLED === 'true',
    walletAddress: process.env.X402_WALLET_ADDRESS,
    price: process.env.X402_PRICE || '$0.01',
    network: (process.env.X402_NETWORK as Network) || 'base-sepolia',
    facilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator',
    useMainnet: process.env.X402_USE_MAINNET === 'true',
  };
}

/**
 * Creates x402 payment middleware for a specific route configuration
 *
 * Authentication Behavior:
 * - Both API key + x402 enabled: Requires BOTH valid X-API-KEY AND X-PAYMENT
 * - Only API key enabled (x402=false): Requires valid X-API-KEY
 * - Only x402 enabled (no API key): Requires valid X-PAYMENT
 * - Neither enabled: Pass through (no authentication)
 *
 * @param routeConfig - Route-specific payment configuration
 * @returns Express middleware for authentication/payment
 */
export function createX402Middleware(
  routeConfig: Record<
    string,
    {
      price?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }
  >
): (req: Request, res: Response, next: NextFunction) => void {
  const config = getX402Config();
  const serverAuthToken = process.env.ELIZA_SERVER_AUTH_TOKEN;

  // If x402 is not enabled, fallback to API key authentication only
  if (!config.enabled) {
    return (req: Request, res: Response, next: NextFunction) => {
      // If no API key is configured, allow all requests
      if (!serverAuthToken) {
        return next();
      }

      // Allow OPTIONS requests for CORS preflight
      if (req.method === 'OPTIONS') {
        return next();
      }

      // Check for valid API key
      const apiKey = req.headers?.['x-api-key'];

      if (!apiKey || apiKey !== serverAuthToken) {
        logger.warn(
          `[x402] Unauthorized access attempt: Missing or invalid X-API-KEY from ${req.ip}`
        );
        return res.status(401).send('Unauthorized: Invalid or missing X-API-KEY');
      }

      // Valid API key, proceed
      logger.debug('[x402] Valid API key provided (x402 disabled, using API key auth only)');
      return next();
    };
  }

  // Validate configuration
  if (!config.walletAddress) {
    logger.error('[x402] X402_ENABLED is true but X402_WALLET_ADDRESS is not set');
    throw new Error('x402 is enabled but X402_WALLET_ADDRESS environment variable is not set');
  }

  // Validate wallet address format (must start with 0x and be 42 characters)
  if (!config.walletAddress.startsWith('0x')) {
    logger.error(
      `[x402] Invalid wallet address format: ${config.walletAddress} - must start with 0x`
    );
    throw new Error('X402_WALLET_ADDRESS must start with 0x (e.g., 0x1234...)');
  }

  if (config.walletAddress.length !== 42) {
    logger.error(
      `[x402] Invalid wallet address length: ${config.walletAddress.length} - must be 42 characters (0x + 40 hex digits)`
    );
    throw new Error(
      'X402_WALLET_ADDRESS must be 42 characters long (0x followed by 40 hex characters)'
    );
  }

  // Validate that the address contains only valid hex characters after 0x
  const hexPattern = /^0x[0-9a-fA-F]{40}$/;
  if (!hexPattern.test(config.walletAddress)) {
    logger.error(
      `[x402] Invalid wallet address format: ${config.walletAddress} - must contain only hex characters after 0x`
    );
    throw new Error(
      'X402_WALLET_ADDRESS must be a valid Ethereum address (0x followed by 40 hexadecimal characters)'
    );
  }

  // Validate CDP credentials for mainnet
  if (config.useMainnet) {
    if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
      logger.error(
        '[x402] X402_USE_MAINNET is true but CDP_API_KEY_ID or CDP_API_KEY_SECRET are not set'
      );
      throw new Error(
        'Mainnet facilitator requires CDP_API_KEY_ID and CDP_API_KEY_SECRET environment variables'
      );
    }
  }

  logger.info(
    `[x402] Payment middleware enabled - wallet: ${config.walletAddress}, network: ${config.network}, mainnet: ${config.useMainnet}, routes: ${Object.keys(routeConfig).join(', ')}`
  );

  // Build the route configuration with network and config
  const enhancedRouteConfig: Record<
    string,
    { price: string; network: Network; config?: Record<string, unknown> }
  > = {};

  for (const [route, routeSettings] of Object.entries(routeConfig)) {
    enhancedRouteConfig[route] = {
      price: routeSettings.price || config.price,
      network: config.network as Network,
    };

    // Add metadata for x402 Bazaar discovery if provided
    if (routeSettings.description || routeSettings.inputSchema || routeSettings.outputSchema) {
      enhancedRouteConfig[route].config = {
        description: routeSettings.description,
        inputSchema: routeSettings.inputSchema,
        outputSchema: routeSettings.outputSchema,
      };
    }
  }

  // Determine facilitator
  const facilitatorConfig = config.useMainnet
    ? facilitator // Use CDP mainnet facilitator
    : { url: config.facilitatorUrl as `${string}://${string}` }; // Use testnet facilitator URL

  // Create the base payment middleware
  const basePaymentMiddleware = paymentMiddleware(
    config.walletAddress as `0x${string}`,
    enhancedRouteConfig,
    facilitatorConfig
  );

  // If both API key and x402 are enabled, validate BOTH
  if (serverAuthToken) {
    return (req: Request, res: Response, next: NextFunction) => {
      // Allow OPTIONS requests for CORS preflight
      if (req.method === 'OPTIONS') {
        return next();
      }

      // First, check API key
      const apiKey = req.headers?.['x-api-key'];

      if (!apiKey || apiKey !== serverAuthToken) {
        logger.warn(`[x402] Unauthorized: Invalid or missing X-API-KEY from ${req.ip}`);
        return res.status(401).send('Unauthorized: Invalid or missing X-API-KEY');
      }

      logger.debug('[x402] Valid API key provided, now validating payment...');

      // API key is valid, now validate payment
      return basePaymentMiddleware(req, res, next);
    };
  }

  // Only x402 enabled (no API key required), just validate payment
  logger.debug('[x402] Payment middleware enabled (no API key required)');
  return (req: Request, res: Response, next: NextFunction) => {
    // Allow OPTIONS requests for CORS preflight
    if (req.method === 'OPTIONS') {
      return next();
    }

    // Validate payment
    return basePaymentMiddleware(req, res, next);
  };
}

/**
 * Simple middleware to log x402 payment status
 * Useful for debugging and monitoring
 */
export function x402LoggingMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const paymentHeader = req.headers['x-payment'];
  if (paymentHeader) {
    logger.debug(`[x402] Payment header received - method: ${req.method}, path: ${req.path}`);
  }
  next();
}
