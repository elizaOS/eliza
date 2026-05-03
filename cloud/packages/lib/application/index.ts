/**
 * Application layer — use cases that coordinate domain operations.
 *
 * Each use case is a class with a single `execute(input)` method, takes its
 * dependencies via constructor injection (always domain interfaces, never
 * concrete infrastructure). Pure business logic — no DB, cache, framework
 * imports allowed.
 *
 * Layering rule: may import from `@/lib/domain/*`. MUST NOT import from
 * `@/lib/infrastructure/*`, `@/lib/services/*`, `@/db/*`, or framework code.
 *
 * Aggregates added one folder at a time. Phase A: empty.
 */

export {};
