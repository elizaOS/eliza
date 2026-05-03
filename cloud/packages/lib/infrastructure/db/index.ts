/**
 * Infrastructure / DB layer — concrete `Postgres*Repository` adapters.
 *
 * Each adapter implements a domain repository interface
 * (`@/lib/domain/<aggregate>/<aggregate>-repository`) by delegating to the
 * existing pure-DB layer in `@/db/repositories/*`. Adapters carry no caching
 * and no business logic — pure shape translation between Drizzle entities
 * and domain types.
 *
 * Aggregates added one folder at a time. Phase A: empty.
 */

export {};
