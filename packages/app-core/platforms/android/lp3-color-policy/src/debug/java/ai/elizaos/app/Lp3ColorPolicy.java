/**
 * Decides whether the direct-distribution Light Phone III color guard may run
 * and repairs only Android's two daltonizer settings. Android lifecycle and
 * SettingsProvider adapters live in the service so this policy remains a
 * deterministic JVM-testable boundary.
 */
package ai.elizaos.app;

final class Lp3ColorPolicy {
    static final String TARGET_MANUFACTURER = "Light";
    static final String TARGET_MODEL = "TLP301";
    static final int COLOR_CORRECTION_DISABLED = 0;
    static final int COLOR_CORRECTION_MODE_DISABLED = -1;
    static final String ACTION_BOOT_COMPLETED = "android.intent.action.BOOT_COMPLETED";
    static final String ACTION_MY_PACKAGE_REPLACED =
        "android.intent.action.MY_PACKAGE_REPLACED";
    static final String ACTION_ENABLE = "ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY";
    static final String ACTION_DISABLE = "ai.elizaos.app.action.DISABLE_LP3_COLOR_POLICY";
    static final String ACTION_SYNC = "ai.elizaos.app.action.SYNC_LP3_COLOR_POLICY";

    enum Decision {
        BUILD_DISABLED,
        WRONG_DEVICE,
        OPTED_OUT,
        MISSING_PERMISSION,
        ELIGIBLE
    }

    enum Outcome {
        BUILD_DISABLED,
        WRONG_DEVICE,
        OPTED_OUT,
        MISSING_PERMISSION,
        ALREADY_CORRECT,
        REPAIRED
    }

    enum OperatorCommand {
        ENABLE,
        DISABLE,
        SYNC,
        NONE
    }

    interface State {
        boolean buildEnabled();

        String manufacturer();

        String model();

        boolean optedIn();

        boolean hasWriteSecureSettings();

        int colorCorrectionEnabled();

        int colorCorrectionMode();

        boolean writeColorCorrectionEnabled(int value);

        boolean writeColorCorrectionMode(int value);
    }

    interface Scheduler {
        void remove(Runnable task);

        void postDelayed(Runnable task, long delayMillis);
    }

    interface OptInWriter {
        boolean commit(boolean enabled);
    }

    static final class Debouncer {
        private final Scheduler scheduler;
        private final Runnable task;
        private final long delayMillis;

        Debouncer(Scheduler scheduler, Runnable task, long delayMillis) {
            this.scheduler = scheduler;
            this.task = task;
            this.delayMillis = delayMillis;
        }

        void request() {
            scheduler.remove(task);
            scheduler.postDelayed(task, delayMillis);
        }

        void cancel() {
            scheduler.remove(task);
        }
    }

    static final class SettingsWriteException extends IllegalStateException {
        SettingsWriteException(String setting, int value) {
            super("SettingsProvider rejected " + setting + "=" + value);
        }
    }

    static final class SettingsReadbackException extends IllegalStateException {
        SettingsReadbackException(int enabled, int mode) {
            super(
                "SettingsProvider readback mismatch: "
                    + "accessibility_display_daltonizer_enabled="
                    + enabled
                    + ", accessibility_display_daltonizer="
                    + mode
            );
        }
    }

    private Lp3ColorPolicy() {}

    static Decision decide(
            boolean buildEnabled,
            String manufacturer,
            String model,
            boolean optedIn,
            boolean hasWriteSecureSettings) {
        if (!buildEnabled) return Decision.BUILD_DISABLED;
        if (!isTargetDevice(manufacturer, model)) return Decision.WRONG_DEVICE;
        if (!optedIn) return Decision.OPTED_OUT;
        if (!hasWriteSecureSettings) return Decision.MISSING_PERMISSION;
        return Decision.ELIGIBLE;
    }

    static boolean isTargetDevice(String manufacturer, String model) {
        return TARGET_MANUFACTURER.equalsIgnoreCase(trim(manufacturer))
            && TARGET_MODEL.equalsIgnoreCase(trim(model));
    }

    static boolean acceptsTrigger(String action) {
        return ACTION_BOOT_COMPLETED.equals(action)
            || ACTION_MY_PACKAGE_REPLACED.equals(action)
            || ACTION_ENABLE.equals(action)
            || ACTION_DISABLE.equals(action)
            || ACTION_SYNC.equals(action);
    }

    static OperatorCommand operatorCommand(String action) {
        if (ACTION_ENABLE.equals(action)) return OperatorCommand.ENABLE;
        if (ACTION_DISABLE.equals(action)) return OperatorCommand.DISABLE;
        if (ACTION_SYNC.equals(action)) return OperatorCommand.SYNC;
        return OperatorCommand.NONE;
    }

    static boolean shouldKeepStickyRestart(boolean initialized, Decision decision) {
        return initialized && decision == Decision.ELIGIBLE;
    }

    static void persistOptIn(OptInWriter writer, boolean enabled) {
        if (!writer.commit(enabled)) {
            throw new IllegalStateException("Could not persist LP3 color policy opt-in");
        }
    }

    static Outcome reconcile(State state) {
        Decision decision = decide(
            state.buildEnabled(),
            state.manufacturer(),
            state.model(),
            state.optedIn(),
            state.hasWriteSecureSettings()
        );
        if (decision != Decision.ELIGIBLE) return Outcome.valueOf(decision.name());

        int initialEnabled = state.colorCorrectionEnabled();
        int initialMode = state.colorCorrectionMode();
        boolean repaired = false;
        if (initialEnabled != COLOR_CORRECTION_DISABLED) {
            if (!state.writeColorCorrectionEnabled(COLOR_CORRECTION_DISABLED)) {
                throw new SettingsWriteException(
                    "accessibility_display_daltonizer_enabled",
                    COLOR_CORRECTION_DISABLED
                );
            }
            repaired = true;
        }
        if (initialMode != COLOR_CORRECTION_MODE_DISABLED) {
            if (!state.writeColorCorrectionMode(COLOR_CORRECTION_MODE_DISABLED)) {
                throw new SettingsWriteException(
                    "accessibility_display_daltonizer",
                    COLOR_CORRECTION_MODE_DISABLED
                );
            }
            repaired = true;
        }
        if (repaired) {
            int finalEnabled = state.colorCorrectionEnabled();
            int finalMode = state.colorCorrectionMode();
            if (
                finalEnabled != COLOR_CORRECTION_DISABLED
                    || finalMode != COLOR_CORRECTION_MODE_DISABLED
            ) {
                throw new SettingsReadbackException(finalEnabled, finalMode);
            }
        }
        return repaired ? Outcome.REPAIRED : Outcome.ALREADY_CORRECT;
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }
}
