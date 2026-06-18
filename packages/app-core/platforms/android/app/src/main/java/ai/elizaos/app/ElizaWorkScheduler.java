package ai.elizaos.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/**
 * Owns the periodic WorkManager schedule for {@link ElizaTasksWorker}.
 *
 * <p>Centralizing the enqueue here keeps the call sites in {@link MainActivity}
 * (app start) and {@link ElizaBootReceiver} (device boot / package replaced)
 * in lockstep — both pass the same unique work name, period, and constraints,
 * so {@link ExistingPeriodicWorkPolicy#KEEP} keeps the schedule idempotent.
 */
final class ElizaWorkScheduler {

    private static final String TAG = "ElizaWorkScheduler";

    static final String UNIQUE_WORK_NAME = "eliza.tasks.refresh";

    // Android caps periodic WorkManager intervals at a minimum of 15 minutes.
    private static final long PERIOD_MINUTES = 15L;

    private ElizaWorkScheduler() {
        // Utility class.
    }

    /**
     * Enqueues the periodic refresh worker if it is not already scheduled.
     * Safe to call repeatedly — {@link ExistingPeriodicWorkPolicy#KEEP} keeps
     * the existing schedule and ignores duplicate calls.
     */
    static void enqueuePeriodic(@NonNull Context context) {
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
        Log.i(TAG, "periodic worker enqueued name=" + UNIQUE_WORK_NAME + " period=" + PERIOD_MINUTES + "m");
    }
}
