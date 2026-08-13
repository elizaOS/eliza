package ai.elizaos.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/**
 * Reconciles the single periodic wake job with the native runtime owner,
 * background preference, and current local-agent credential.
 */
final class ElizaWorkScheduler {

    private static final String TAG = "ElizaWorkScheduler";

    static final String CAPACITOR_PREFS_GROUP = "CapacitorStorage";
    static final String BACKGROUND_ENABLED_KEY = "eliza:background-enabled";
    static final String RUNTIME_MODE_KEY = "eliza:mobile-runtime-mode";
    static final String UNIQUE_WORK_NAME = "eliza.tasks.refresh";

    // Android caps periodic WorkManager intervals at a minimum of 15 minutes.
    private static final long PERIOD_MINUTES = 15L;

    private ElizaWorkScheduler() {
        // Utility class.
    }

    /** The immutable inputs and outcome used by the scheduler and worker. */
    static final class Decision {
        final boolean shouldSchedule;
        final String reason;
        final String deviceSecret;

        Decision(boolean shouldSchedule, String reason, String deviceSecret) {
            this.shouldSchedule = shouldSchedule;
            this.reason = reason;
            this.deviceSecret = deviceSecret;
        }
    }

    /** WorkManager operations are abstracted so schedule and cancel are host-testable. */
    interface ScheduleBackend {
        void enqueue();
        void cancel();
    }

    /**
     * Makes the desired state authoritative: exactly one periodic job for a
     * provisioned on-device runtime, and no job for every other state.
     */
    static void reconcile(@NonNull Context context) {
        Decision decision = readDecision(context);
        reconcileDecision(decision, new WorkManagerBackend(context.getApplicationContext()));
        Log.i(
            TAG,
            "periodic wake " + (decision.shouldSchedule ? "scheduled" : "cancelled")
                + " reason=" + decision.reason
        );
    }

    static Decision readDecision(@NonNull Context context) {
        SharedPreferences prefs = context.getSharedPreferences(
            CAPACITOR_PREFS_GROUP,
            Context.MODE_PRIVATE
        );
        return decide(
            isBackgroundEnabled(prefs),
            readString(prefs, RUNTIME_MODE_KEY),
            ElizaAgentService.localAgentToken(context)
        );
    }

    static Decision decide(boolean backgroundEnabled, String runtimeMode, String deviceSecret) {
        if (!backgroundEnabled) {
            return new Decision(false, "background-disabled", null);
        }
        String mode = runtimeMode == null ? null : runtimeMode.trim();
        if (!ElizaAgentService.isOnDeviceAgentRuntimeMode(mode)) {
            return new Decision(false, "runtime-not-owned", null);
        }
        String secret = deviceSecret == null ? null : deviceSecret.trim();
        if (secret == null || secret.isEmpty()) {
            return new Decision(false, "credential-unprovisioned", null);
        }
        return new Decision(true, "owned-target-provisioned", secret);
    }

    static void reconcileDecision(Decision decision, ScheduleBackend backend) {
        if (decision.shouldSchedule) {
            backend.enqueue();
        } else {
            backend.cancel();
        }
    }

    static boolean isBackgroundEnabled(SharedPreferences prefs) {
        if (prefs == null || !prefs.contains(BACKGROUND_ENABLED_KEY)) {
            return true;
        }
        try {
            return prefs.getBoolean(BACKGROUND_ENABLED_KEY, true);
        } catch (ClassCastException notBoolean) {
            // error-policy:J3 Capacitor writes string booleans; parse only the
            // explicit disabled value and never manufacture another setting.
            String value = readString(prefs, BACKGROUND_ENABLED_KEY);
            return !"false".equalsIgnoreCase(value);
        }
    }

    private static String readString(SharedPreferences prefs, String key) {
        try {
            return prefs == null ? null : prefs.getString(key, null);
        } catch (ClassCastException notString) {
            // error-policy:J3 an unexpected preference type is not a valid
            // runtime owner or credential source.
            Log.w(TAG, "invalid non-string preference key=" + key);
            return null;
        }
    }

    private static final class WorkManagerBackend implements ScheduleBackend {
        private final Context context;

        WorkManagerBackend(Context context) {
            this.context = context;
        }

        @Override
        public void enqueue() {
            Constraints constraints = new Constraints.Builder()
                .setRequiresBatteryNotLow(true)
                .build();
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                ElizaTasksWorker.class,
                PERIOD_MINUTES,
                TimeUnit.MINUTES
            )
                .setConstraints(constraints)
                .build();
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            );
        }

        @Override
        public void cancel() {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_WORK_NAME);
        }
    }
}
