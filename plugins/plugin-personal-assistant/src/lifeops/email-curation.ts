/**
 * Email-curation engine — moved to `@elizaos/plugin-inbox`.
 *
 * The pure decision engine (email + context → save/archive/delete/review with
 * evidence and citations) now lives in the inbox domain plugin, wired into the
 * inbox triage flow. This file is a thin re-export shim so existing LifeOps
 * imports (and the `lifeops/index.ts` barrel) keep resolving unchanged.
 *
 * PA does not depend on the inbox plugin's services or DB — it only re-exports
 * the pure engine's public surface.
 */

export * from "@elizaos/plugin-inbox/inbox/email-curation";
