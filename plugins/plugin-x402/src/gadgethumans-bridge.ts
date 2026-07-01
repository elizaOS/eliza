/**
 * @gadgethumans/x402 Bridge — wraps MCP Server instances with GadgetHumans'
 * one-line payment middleware.
 *
 * This file bridges the @gadgethumans/x402 npm package with elizaOS's MCP
 * tool system. It wraps the MCP server so every tool call requires an x402
 * micropayment (USDC on Base), with a 0.5% commission routed to GadgetHumans.
 *
 * Usage:
 *   import { wrapWithGadgetHumansX402 } from '@elizaos/plugin-x402/gadgethumans-bridge';
 *   import { Server } from '@modelcontextprotocol/sdk/server/index.js';
 *
 *   const server = new Server({ name: 'my-server', version: '1.0.0' });
 *   wrapWithGadgetHumansX402(server, { commission: 0.005 });
 *
 * Dependencies:
 *   npm install @gadgethumans/x402
 */

import { logger } from "@elizaos/core";

/**
 * Wraps an MCP Server instance with @gadgethumans/x402 payment middleware.
 *
 * Every tool call through this server will require an x402 micropayment.
 * The calling agent must include an x402 payment header; if none is present,
 * the middleware returns a 402 response with payment instructions.
 *
 * @param server       MCP Server instance to wrap
 * @param opts         Optional configuration
 * @param opts.commission       Our commission rate (default: 0.005 = 0.5%)
 * @param opts.affiliateId      Pyrimid affiliate ID for referral tracking
 * @param opts.destinationWallet Where to forward payments after commission
 * @returns The wrapped server
 */
export async function wrapWithGadgetHumansX402(
  server: any,
  opts: {
    commission?: number;
    affiliateId?: string;
    destinationWallet?: string;
  } = {},
): Promise<any> {
  try {
    // Dynamic import so @gadgethumans/x402 is an optional dependency
    const { wrapMCPServer } = await import("@gadgethumans/x402");
    const wrapped = wrapMCPServer(server, {
      commission: opts.commission ?? 0.005,
      affiliateId: opts.affiliateId ?? undefined,
      destinationWallet: opts.destinationWallet ?? undefined,
    });
    logger.success(
      `[gadgethumans-x402] MCP server wrapped with x402 payment middleware (commission: ${(opts.commission ?? 0.005) * 100}%)`,
    );
    return wrapped;
  } catch (e: any) {
    logger.warn(
      `[gadgethumans-x402] @gadgethumans/x402 not installed — skipping. Install with: npm install @gadgethumans/x402`,
    );
    logger.debug(`[gadgethumans-x402] Error: ${e.message}`);
    return server;
  }
}
