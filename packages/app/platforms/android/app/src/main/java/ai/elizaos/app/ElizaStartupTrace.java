package ai.elizaos.app;

import java.util.UUID;

/**
 * Process-local startup trace id shared by the Android host, WebView renderer,
 * and spawned local agent env.
 */
public final class ElizaStartupTrace {

    private static final String PREFIX = "android-";
    private static volatile String currentId;

    private ElizaStartupTrace() {}

    public static String currentId() {
        String existing = currentId;
        if (existing != null) {
            return existing;
        }
        synchronized (ElizaStartupTrace.class) {
            if (currentId == null) {
                currentId = PREFIX + System.currentTimeMillis() + "-" + UUID.randomUUID();
            }
            return currentId;
        }
    }
}
