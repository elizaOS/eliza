package ai.elizaos.app;

/** Native presentation ownership is narrower than a configured preference. */
final class NativeNotificationState {
    static boolean enabled(String state, boolean configured, boolean current, boolean allowed, boolean activated) {
        return activated && configured && current && allowed &&
            ("connecting".equals(state) || "connected".equals(state) || "disconnected".equals(state));
    }
}
