/**
 * OWNER_FINANCES payment-source / spending handler.
 *
 * The implementation lives in `@elizaos/plugin-finances` with the finance
 * back-end. This module re-exports `runPaymentsHandler` so importers (the
 * `money.ts` umbrella dispatcher and integration tests) keep resolving it from
 * here. The handler constructs a `FinancesService` internally.
 */

export { runPaymentsHandler } from "@elizaos/plugin-finances/actions/finances";
