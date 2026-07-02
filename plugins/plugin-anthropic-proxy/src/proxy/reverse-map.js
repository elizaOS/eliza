/**
 * Response transformation: reverse all bidirectional mappings.
 *
 * Order matches proxy.js reverseMap():
 *   1. Tool name renames (more specific patterns) — both quoted + escaped-quoted
 *   2. Property name renames — both quoted + escaped-quoted
 *   3. String replacements (using reverseMap pairs)
 */
import { applyReplacements } from "./sanitize.js";
import { applyQuotedRenamesReverse } from "./tool-rename.js";
export function reverseMap(text, config) {
    let r = text;
    r = applyQuotedRenamesReverse(r, config.toolRenames);
    r = applyQuotedRenamesReverse(r, config.propRenames);
    r = applyReplacements(r, config.reverseMap);
    return r;
}
//# sourceMappingURL=reverse-map.js.map