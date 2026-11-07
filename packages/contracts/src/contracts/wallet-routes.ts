/**
 * Zod schemas for the wallet HTTP routes — local key management
 * and primary-wallet selection.
 *
 * Routes covered:
 *   POST /api/wallet/import   { privateKey, chain?: 'evm'|'solana' }
 *   POST /api/wallet/generate { chain?: 'evm'|'solana'|'both',
 *                                source?: 'local'|'steward' }
 *   POST /api/wallet/primary  { chain: 'evm'|'solana',
 *                                source: 'local'|'cloud' }
 *
 * Browser-signing routes (`/api/wallet/browser-*`) keep their own
 * field-level coercion helpers (`normalizeBrowserString`, etc.) — they
 * accept partial unions of legacy shapes that don't model cleanly as
 * a single zod schema, so they're intentionally not migrated here.
 *
 * `PUT /api/wallet/config` is also intentionally left as-is: it uses
 * the dedicated `resolveWalletConfigUpdateRequest` validator that
 * walks the legacy + current update shapes, and consolidating it
 * would require porting a non-trivial helper.
 */

import z from "zod";

const WalletChainSchema = z.enum(["evm", "solana"]);
const WalletGenerateChainSchema = z.enum(["evm", "solana", "both"]);
const WalletGenerateSourceSchema = z.enum(["local", "steward"]);
const WalletPrimarySourceSchema = z.enum(["local", "cloud"]);

export const PostWalletImportRequestSchema = z
  .object({
    chain: WalletChainSchema.optional(),
    privateKey: z.string().regex(/\S/, "privateKey is required"),
  })
  .strict()
  .transform((value) => ({
    ...(value.chain ? { chain: value.chain } : {}),
    privateKey: value.privateKey.trim(),
  }));

export const PostWalletGenerateRequestSchema = z
  .object({
    chain: WalletGenerateChainSchema.optional(),
    source: WalletGenerateSourceSchema.optional(),
  })
  .strict();

export const PostWalletPrimaryRequestSchema = z
  .object({
    chain: WalletChainSchema,
    source: WalletPrimarySourceSchema,
  })
  .strict();

export type PostWalletImportRequest = z.infer<
  typeof PostWalletImportRequestSchema
>;
export type PostWalletGenerateRequest = z.infer<
  typeof PostWalletGenerateRequestSchema
>;
export type PostWalletPrimaryRequest = z.infer<
  typeof PostWalletPrimaryRequestSchema
>;
export type WalletChainInput = z.infer<typeof WalletChainSchema>;
export type WalletGenerateChain = z.infer<typeof WalletGenerateChainSchema>;
export type WalletGenerateSource = z.infer<typeof WalletGenerateSourceSchema>;
export type WalletPrimarySource = z.infer<typeof WalletPrimarySourceSchema>;
