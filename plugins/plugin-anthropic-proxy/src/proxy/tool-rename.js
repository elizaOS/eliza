/**
 * Layer 3 & Layer 6: Tool name + property name renames.
 *
 * Forward direction: apply as quoted ("name") replacement on the outgoing body
 * to defeat tool-name fingerprinting.
 *
 * Reverse direction: handle BOTH quoted and escaped-quoted forms because SSE
 * input_json_delta embeds tool args as strings where inner quotes are escaped.
 */
export function applyQuotedRenames(input, pairs) {
    let m = input;
    for (const [orig, renamed] of pairs) {
        m = m.split(`"${orig}"`).join(`"${renamed}"`);
    }
    return m;
}
/**
 * Reverse-direction: handles plain ("Name") AND escaped (\"Name\") forms.
 * pairs is the forward map; we reverse it (rename -> orig) on the wire.
 */
export function applyQuotedRenamesReverse(input, pairs) {
    let r = input;
    for (const [orig, renamed] of pairs) {
        r = r.split(`"${renamed}"`).join(`"${orig}"`);
        r = r.split(`\\"${renamed}\\"`).join(`\\"${orig}\\"`);
    }
    return r;
}
//# sourceMappingURL=tool-rename.js.map