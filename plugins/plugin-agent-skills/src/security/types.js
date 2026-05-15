/**
 * Types for the skill security scanner.
 */
export function truncateEvidence(evidence, maxLen = 120) {
    if (evidence.length <= maxLen)
        return evidence;
    return `${evidence.slice(0, maxLen)}…`;
}
//# sourceMappingURL=types.js.map