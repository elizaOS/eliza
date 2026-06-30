/**
 * Connector setup HTTP-route contract.
 *
 * The canonical definitions now live in `@elizaos/core`
 * (`packages/core/src/types/connector-setup.ts`) — the innermost package both
 * this API host and every connector plugin already depend on, so there is a
 * single source of truth instead of locally-mirrored copies (#10201).
 *
 * This module re-exports them so the long-standing `@elizaos/app-core` import
 * path (and `@elizaos/app-core/api/setup-contract`) keeps working unchanged.
 *
 * The contract is pinned by `plugins/__tests__/setup-routes-contract.test.ts`.
 * `docs/first-run-contracts.md` covers the connector setup surface.
 */

export type {
  SetupErrorCode,
  SetupErrorResponse,
  SetupState,
  SetupStatusResponse,
} from "@elizaos/core";
export { buildSetupError, SETUP_ERROR_CODES, setupPath } from "@elizaos/core";
