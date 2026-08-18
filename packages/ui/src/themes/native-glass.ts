/**
 * Shared native-glass material tokens. The overlay shells (AssistantOverlay,
 * ChatOverlay) anchor the same iOS native-glass tint; keeping the literal here
 * — the one policy-sanctioned color-token location — means the surfaces cannot
 * drift apart and component code stays free of raw color literals (the
 * hardcoded-color ratchet enforces the latter).
 */

/** Dark chrome tint (RGBA hex) for native liquid-glass overlay anchors. */
export const NATIVE_GLASS_DARK_TINT = "#16090DD9";
