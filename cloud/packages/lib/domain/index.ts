/**
 * Domain layer — pure business types and interfaces.
 *
 * Layering rule: this directory MUST NOT import from `@/lib/infrastructure/*`,
 * `@/lib/services/*`, `@/db/*`, or anything else outside the domain. Domain
 * types depend only on language primitives and other domain types.
 *
 * Aggregates are added one folder at a time during the Clean Architecture
 * migration (see plan: `~/.claude/plans/met-toi-en-mode-tidy-squirrel.md`).
 *
 * Phase A: only `cache/` (the contract used by infrastructure decorators).
 */

export type { Cache } from "@/lib/domain/cache/cache";
