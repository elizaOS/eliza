// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.UserManager;

public final class SystemUpdateJob extends JobService {
    static final int PERIODIC = 20851, REQUESTED = 20852;

    static void schedule(Context context, boolean requested) {
        UserManager users = context.getSystemService(UserManager.class);
        if (!context.getResources().getBoolean(R.bool.os_update_enabled) || users == null || !users.isSystemUser()) return;
        JobInfo.Builder job = new JobInfo.Builder(requested ? REQUESTED : PERIODIC,
                new ComponentName(context, SystemUpdateJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .setRequiresBatteryNotLow(true)
                .setRequiresStorageNotLow(true).setPersisted(true);
        if (requested) job.setMinimumLatency(60_000);
        else job.setRequiresDeviceIdle(true).setPeriodic(6 * 60 * 60_000L, 60 * 60_000L);
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null || scheduler.schedule(job.build()) != JobScheduler.RESULT_SUCCESS) {
            UpdateRunner.status(context, "System update check could not be scheduled");
        }
    }

    @Override public boolean onStartJob(JobParameters parameters) {
        return UpdateRunner.get(this).start(parameters.getJobId(), () -> jobFinished(parameters, false));
    }

    @Override public boolean onStopJob(JobParameters parameters) {
        return UpdateRunner.get(this).stop(parameters.getJobId());
    }

    public static final class Boot extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                    || Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
                schedule(context, false); schedule(context, true);
            }
        }
    }
}
