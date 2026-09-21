/**
 * Type-only compatibility exports for the standalone @elizaos/plugin-form package.
 *
 * Runtime form service/action/provider/evaluator ownership lives in
 * plugins/plugin-form. Core keeps these types only so older type imports from
 * the advanced-capabilities path do not pull in a second FORM implementation.
 */

export type * from "./types.ts";
