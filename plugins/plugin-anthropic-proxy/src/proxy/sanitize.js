/**
 * Layer 2: String trigger sanitization (split/join over the entire body).
 *
 * Plain forward map (apply to outgoing body) and reverse map (apply to
 * incoming response body / SSE stream).
 */
export function applyReplacements(input, pairs) {
    let m = input;
    for (const [find, replace] of pairs) {
        // split/join is the algorithm used by proxy.js — preserves byte parity.
        m = m.split(find).join(replace);
    }
    return m;
}
//# sourceMappingURL=sanitize.js.map