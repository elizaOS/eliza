/**
 * useLifeOpsSelection — re-exports the LifeOpsSelection type and
 * useLifeOpsSelection hook from LifeOpsSelectionContext so that hook-based
 * callers don't need to import directly from the component tree.
 *
 * The canonical implementation lives in
 * components/LifeOpsSelectionContext.tsx.
 */

export type { LifeOpsSelection } from "../components/LifeOpsSelectionContext.js";
export { useLifeOpsSelection } from "../components/LifeOpsSelectionContext.js";
