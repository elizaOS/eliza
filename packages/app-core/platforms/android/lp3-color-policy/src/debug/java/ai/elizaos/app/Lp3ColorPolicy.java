/**
 * Decides whether the direct-distribution Light Phone III color guard may run
 * and repairs only Android's two daltonizer settings. Android lifecycle and
 * SettingsProvider adapters live in the service so eligibility, notification
 * disclosure, and listener lifecycle remain deterministic JVM-testable
 * boundaries.
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
    static final String ACTION_APP_NOTIFICATION_BLOCK_STATE_CHANGED =
        "android.app.action.APP_BLOCK_STATE_CHANGED";
    static final String ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED =
        "android.app.action.NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED";
    static final String NOTIFICATION_CHANNEL_ID = "lp3_color_policy";

    enum Decision {
        BUILD_DISABLED,
        WRONG_DEVICE,
        OPTED_OUT,
        MISSING_PERMISSION,
        MISSING_NOTIFICATION_PERMISSION,
        MISSING_NOTIFICATION_DISCLOSURE,
        ELIGIBLE
    }

    enum Outcome {
        BUILD_DISABLED,
        WRONG_DEVICE,
        OPTED_OUT,
        MISSING_PERMISSION,
        MISSING_NOTIFICATION_PERMISSION,
        MISSING_NOTIFICATION_DISCLOSURE,
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

        boolean hasPostNotificationsPermission();

        boolean hasVisibleNotificationDisclosure();

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

    interface RegistrationHooks {
        void register();

        void unregister();
    }

    static final class LifecycleRegistration {
        private boolean registered;

        void update(boolean shouldRegister, RegistrationHooks hooks) {
            if (shouldRegister == registered) return;
            if (shouldRegister) {
                hooks.register();
                registered = true;
            } else {
                hooks.unregister();
                registered = false;
            }
        }

        boolean isRegistered() {
            return registered;
        }
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
            boolean hasWriteSecureSettings,
            boolean hasPostNotificationsPermission,
            boolean hasVisibleNotificationDisclosure) {
        if (!buildEnabled) return Decision.BUILD_DISABLED;
        if (!isTargetDevice(manufacturer, model)) return Decision.WRONG_DEVICE;
        if (!optedIn) return Decision.OPTED_OUT;
        if (!hasWriteSecureSettings) return Decision.MISSING_PERMISSION;
        if (!hasPostNotificationsPermission) {
            return Decision.MISSING_NOTIFICATION_PERMISSION;
        }
        if (!hasVisibleNotificationDisclosure) {
            return Decision.MISSING_NOTIFICATION_DISCLOSURE;
        }
        return Decision.ELIGIBLE;
    }

    static boolean hasVisibleNotificationDisclosure(
            boolean appNotificationsEnabled,
            boolean channelExists,
            boolean channelBlocked) {
        return appNotificationsEnabled && (!channelExists || !channelBlocked);
    }

    static boolean acceptsNotificationStateChange(String action, String channelId) {
        if (ACTION_APP_NOTIFICATION_BLOCK_STATE_CHANGED.equals(action)) return true;
        return ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED.equals(action)
            && NOTIFICATION_CHANNEL_ID.equals(channelId);
    }

    static boolean canRecoverThroughNotificationState(Decision decision) {
        return decision == Decision.ELIGIBLE
            || decision == Decision.MISSING_NOTIFICATION_PERMISSION
            || decision == Decision.MISSING_NOTIFICATION_DISCLOSURE;
    }

    static boolean shouldRequestPostNotifications(
            Decision decision,
            boolean alreadyRequested) {
        return decision == Decision.MISSING_NOTIFICATION_PERMISSION && !alreadyRequested;
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
            state.hasWriteSecureSettings(),
            state.hasPostNotificationsPermission(),
            state.hasVisibleNotificationDisclosure()
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
