import { z } from 'zod';
import type { RouteId } from './routes.js';

const address = (what: string) => z.string().regex(/^0x[0-9a-fA-F]{40}$/, `${what} must be a 0x-prefixed 40-hex address`);

export const inputSchemas = {
  scan: z.object({ address: address('address').describe('Token contract on Base') }).strict(),
  'sentinel-latest': z.object({
    limit: z.number().int().min(1).max(500).optional().describe('Max pools to return (default 50)'),
    maxRisk: z.number().min(0).max(100).optional(),
    minRisk: z.number().min(0).max(100).optional(),
    dex: z.enum(['uniswap-v4', 'uniswap-v3', 'aerodrome', 'aerodrome-slipstream']).optional(),
    since: z.string().datetime().optional().describe('ISO timestamp; only pools detected after it')
  }).strict(),
  'approval-risk': z.object({
    token: address('token'),
    owner: address('owner'),
    spenders: z.array(address('spender')).max(20).optional().describe('Extra spenders to check beyond the log window')
  }).strict(),
  simulate: z.object({
    token: address('token'),
    side: z.enum(['buy', 'sell']),
    amount: z.string().regex(/^(?!0+(\.0+)?$)\d+(\.\d+)?$/, 'amount must be a positive decimal string').describe('ETH for buy, token units for sell'),
    wallet: address('wallet').describe('Address simulated as the trader (no transaction is sent)')
  }).strict(),
  'liquidity-risk': z.object({
    token: address('token'),
    pair: address('pair').optional().describe('Analyze only this pool')
  }).strict()
} satisfies Record<RouteId, z.ZodTypeAny>;

export type RouteInput<R extends RouteId> = z.infer<(typeof inputSchemas)[R]>;
