package ai.elizaos.updater;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Network;
import android.os.Build;
import android.os.UpdateEngine;
import android.os.UpdateEngineCallback;
import android.util.Log;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLConnection;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * One periodic look at update_engine and the signed channel. update_engine works outside this
 * process and takes no wake lock, so a run stays open until it finishes: the job's wake lock keeps
 * the CPU up. A failed run ends quietly and the next one retries: nothing here shows an error.
 */
public final class UpdateJob extends JobService {
    static final String STATE = "state";
    private static final int JOB_ID = 1;
    /** update_engine's CLEANUP_PREVIOUS_UPDATE, which UpdateStatusConstants leaves out: the merge after a restart. */
    private static final int MERGING = 11;
    private static final String NOTIFICATION_CHANNEL = "updates";
    private static final int TIMEOUT_MILLIS = 30_000;

    private Thread worker;

    static SharedPreferences store(Context context) {
        return context.getSharedPreferences("updater", Context.MODE_PRIVATE);
    }

    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler.getPendingJob(JOB_ID) != null) return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, UpdateJob.class))
                .setPersisted(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .setRequiresBatteryNotLow(true)
                .setPeriodic(TimeUnit.HOURS.toMillis(6), TimeUnit.HOURS.toMillis(2))
                .setBackoffCriteria(TimeUnit.MINUTES.toMillis(15), JobInfo.BACKOFF_POLICY_LINEAR)
                .build());
    }

    @Override public boolean onStartJob(JobParameters params) {
        worker = new Thread(() -> jobFinished(params, run(params)));
        worker.start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) {
        worker.interrupt();
        return true;
    }

    /** True when the work is not over: the job's backoff brings the next look. */
    private boolean run(JobParameters params) {
        try {
            UpdateEngine engine = new UpdateEngine();
            CompletableFuture<Integer> status = new CompletableFuture<>();
            CompletableFuture<Integer> applied = new CompletableFuture<>();
            engine.bind(new UpdateEngineCallback() {
                @Override public void onStatusUpdate(int value, float percent) {
                    status.complete(value);
                }
                @Override public void onPayloadApplicationComplete(int errorCode) {
                    applied.complete(errorCode);
                }
            });
            try {
                switch (status.get(TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
                    case UpdateEngine.UpdateStatusConstants.IDLE:
                        if (!check(engine, params)) return false;
                        break;
                    case UpdateEngine.UpdateStatusConstants.UPDATED_NEED_REBOOT:
                        offerRestart();
                        return false;
                    case MERGING:
                        // The booted build is the update; a later run reads the channel once the merge is over.
                        store(this).edit().putString(STATE, "up-to-date").apply();
                        return true;
                    default:
                        store(this).edit().putString(STATE, "downloading").apply();
                }
                if (applied.get() != UpdateEngine.ErrorCodeConstants.SUCCESS) return true;
                offerRestart();
                return false;
            } finally {
                engine.unbind();
            }
        } catch (InterruptedException stopped) {
            return true;
        } catch (Exception failure) {
            Log.w("ElizaOsUpdater", "Update run ended early", failure);
            return false;
        }
    }

    /** True when update_engine took a payload. */
    private boolean check(UpdateEngine engine, JobParameters params) throws Exception {
        Network network = params.getNetwork();
        String url = getString(R.string.channel_manifest_url);
        String channel = getString(R.string.channel);
        String sequenceKey = "sequence." + channel;
        SharedPreferences store = store(this);
        ChannelManifest manifest = ChannelManifest.verify(fetch(network, url), fetch(network, url + ".sig"),
                getString(R.string.channel_key), channel, Build.DEVICE, store.getLong(sequenceKey, 0));
        store.edit().putLong(sequenceKey, manifest.sequence).apply();
        ChannelManifest.Update update = manifest.offer(Build.FINGERPRINT, Build.TIME, installId(store));
        if (update == null) {
            store.edit().putString(STATE, "up-to-date").apply();
            return false;
        }
        engine.applyPayload(update.url, update.offset, update.size, update.headers(network.getNetworkHandle()));
        store.edit().putString(STATE, "downloading").apply();
        return true;
    }

    /** A random value of this install, never a hardware identifier: only the rollout bucket reads it. */
    private static String installId(SharedPreferences store) {
        String id = store.getString("installId", null);
        if (id != null) return id;
        id = UUID.randomUUID().toString();
        store.edit().putString("installId", id).apply();
        return id;
    }

    private static byte[] fetch(Network network, String url) throws IOException {
        URLConnection connection = network.openConnection(new URL(url));
        connection.setConnectTimeout(TIMEOUT_MILLIS);
        connection.setReadTimeout(TIMEOUT_MILLIS);
        try (InputStream body = connection.getInputStream()) {
            byte[] bytes = body.readNBytes(ChannelManifest.MAX_BYTES + 1);
            if (bytes.length > ChannelManifest.MAX_BYTES) throw new IOException("Channel response is too large");
            return bytes;
        }
    }

    private void offerRestart() {
        store(this).edit().putString(STATE, "ready").apply();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(NOTIFICATION_CHANNEL, "System updates", NotificationManager.IMPORTANCE_LOW));
        PendingIntent restart = PendingIntent.getBroadcast(this, 0,
                new Intent(UpdateReceiver.ACTION_RESTART).setClass(this, UpdateReceiver.class), PendingIntent.FLAG_IMMUTABLE);
        notifications.notify(1, new Notification.Builder(this, NOTIFICATION_CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Update ready")
                .addAction(new Notification.Action.Builder(null, "Restart", restart).build())
                .build());
    }
}
