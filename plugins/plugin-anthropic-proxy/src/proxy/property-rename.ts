/**
 * Layer 6: Property name renames.
 *
 * Thin re-export — algorithm shared with tool-rename.ts (quoted replacement).
 * Kept as a separate module to mirror the layer structure of proxy.js.
 */

export { applyQuotedRenames as applyPropertyRenames } from "./tool-rename.js";
