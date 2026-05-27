/**
 * @suedeai/plugin-suede
 *
 * ElizaOS plugin for rights-aware music and video generation, payable by AI
 * agents via x402 (USDC on Base mainnet).
 *
 * Suede exposes 17 pay-per-call endpoints on https://app.suedeai.ai. Endpoint
 * discovery is served at https://app.suedeai.ai/.well-known/x402.json. This
 * plugin is a thin re-export of the published npm package
 * `@suedeai/plugin-suede` so the ElizaOS monorepo can reference it without
 * vendoring the implementation.
 *
 * Source of truth: https://github.com/Suede-AI/elizaos-plugin-suede
 * Published: https://www.npmjs.com/package/@suedeai/plugin-suede
 */

export * from "@suedeai/plugin-suede";
export { default } from "@suedeai/plugin-suede";
