/**
 * Re-export of the AOSP variant config interface for tooling that
 * wants to import it as a type. The runtime implementation of every
 * AOSP toolkit script reads the variant config via regex from the
 * host's `app.config.ts` (see `lib/load-variant-config.mjs`); this
 * file just makes the TypeScript definition available next to the
 * scripts so editors / external tooling don't have to walk back to
 * `@elizaos/ui/config/app-config` to find it.
 */
export type { AospVariantConfig } from "@elizaos/ui/config/app-config";
