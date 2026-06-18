/**
 * OWNER_FINANCES payment-source / spending handler.
 *
 * The implementation moved to `@elizaos/plugin-finances` along with the finance
 * back-end. This module re-exports `runPaymentsHandler` so existing importers
 * (the `money.ts` umbrella dispatcher + integration tests) keep resolving it
 * from here. The handler constructs a `FinancesService` internally.
 */

export { runPaymentsHandler } from "@elizaos/plugin-finances";
