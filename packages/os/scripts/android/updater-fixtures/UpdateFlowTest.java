package ai.elizaos.updater;

import android.Device;
import android.app.AppOpsManager;
import android.app.NotificationManager;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.ServiceSpecificException;
import android.os.UpdateEngine;
import android.os.UpdateEngine.ErrorCodeConstants;
import android.os.UpdateEngine.UpdateStatusConstants;
import android.telecom.TelecomManager;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** The real job, receiver and provider on a fake platform: what each update_engine status leads to. */
public final class UpdateFlowTest {
    private static final String CHANNEL = "https://updates.example/channels/stallion-beta.json";
    private static final String BOOTED = "Alpha/alpha_stallion_phone/stallion:17/CP2A.260605.016/20261102.1:userdebug/test-keys";
    private static final String NEXT = "Alpha/alpha_stallion_phone/stallion:17/CP2A.260605.016/20261103.1:userdebug/test-keys";
    private static final String READ_STATUS = "ai.elizaos.updater.permission.READ_STATUS";
    private static final long BUILT = 1_793_000_000L;
    private static int checks;
    private static KeyPair keys;
    /** What was on disk when update_engine took the payload. */
    private static Map<String, Object> durableAtApply;

    private static void check(boolean value) {
        if (!value) throw new AssertionError("Check " + checks);
        checks++;
    }

    private static byte[] manifest(long sequence, int rollout, long date) {
        return ("{\"schema\":1,\"channel\":\"beta\",\"device\":\"stallion\",\"version\":\"1.0.0\",\"sequence\":" + sequence
            + ",\"buildFingerprint\":\"" + NEXT + "\",\"buildDateUtc\":" + date + ",\"rolloutPercent\":" + rollout
            + ",\"updates\":[{\"from\":null,\"url\":\"https://updates.example/ota.zip\",\"payload\":{\"offset\":41,\"size\":1000,"
            + "\"properties\":[\"FILE_HASH=aA==\",\"FILE_SIZE=1000\",\"METADATA_HASH=bQ==\",\"METADATA_SIZE=12\"]}}]}").getBytes(StandardCharsets.UTF_8);
    }

    private static void publish(byte[] manifest) throws Exception {
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(keys.getPrivate());
        signer.update(manifest);
        Device.channel.put(CHANNEL, manifest);
        Device.channel.put(CHANNEL + ".sig", signer.sign());
    }

    /** The published manifest, valid and signed, padded with trailing spaces to `size` bytes. */
    private static void publishSized(int size) throws Exception {
        byte[] body = manifest(5, 100, BUILT + 1);
        byte[] padded = Arrays.copyOf(body, size);
        Arrays.fill(padded, body.length, size, (byte) ' ');
        publish(padded);
    }

    private static void reset() throws Exception {
        Device.stored.clear();
        Device.durable.clear();
        Device.commitFails = false;
        Device.fetching = null;
        Device.committed = null;
        Device.notifications.clear();
        Device.fetched.clear();
        UpdateEngine.applied.clear();
        Device.channel.clear();
        Device.reboots.clear();
        Device.callerPermissions.clear();
        UpdateEngine.status = UpdateStatusConstants.IDLE;
        UpdateEngine.denied = false;
        UpdateEngine.applyFailure = null;
        UpdateEngine.unbinds = 0;
        UpdateEngine.outcome = ErrorCodeConstants.ERROR;
        UpdateEngine.callback = null;
        UpdateEngine.applying = () -> durableAtApply = new HashMap<>(Device.durable);
        durableAtApply = null;
        Device.audioMode = AudioManager.MODE_NORMAL;
        Device.inCall = false;
        Device.phoneStateGranted = true;
        Device.phoneStateOpAllowed = true;
        Device.services.put(JobScheduler.class, new JobScheduler());
        Device.services.put(NotificationManager.class, new NotificationManager());
        Device.services.put(AppOpsManager.class, new AppOpsManager());
        Device.services.put(AudioManager.class, new AudioManager());
        Device.services.put(TelecomManager.class, new TelecomManager());
        Device.services.put(PowerManager.class, new PowerManager());
        publish(manifest(5, 100, BUILT + 1));
    }

    /** One job run; returns whether it asked for its backoff. */
    private static boolean run() throws Exception {
        check(new UpdateJob().onStartJob(new JobParameters()));
        Boolean reschedule = Device.finished.poll(10, TimeUnit.SECONDS);
        check(reschedule != null);
        return reschedule;
    }

    private static Object state() {
        return Device.stored.get(UpdateJob.STATE);
    }

    private static void quietFailure(boolean reschedule) {
        check(!reschedule);
        check(Device.notifications.isEmpty());
        check(UpdateEngine.applied.isEmpty());
        check(state() == null);
    }

    private static void schedule() throws Exception {
        reset();
        new UpdateReceiver().onReceive(new Context(), new Intent(Intent.ACTION_BOOT_COMPLETED));
        JobScheduler scheduler = (JobScheduler) Device.services.get(JobScheduler.class);
        JobInfo job = scheduler.pending.get(1);
        check(job.persisted && job.batteryNotLow && job.networkType == JobInfo.NETWORK_TYPE_UNMETERED);
        check(job.period == TimeUnit.HOURS.toMillis(6) && job.flex == TimeUnit.HOURS.toMillis(2));
        check(job.backoff == TimeUnit.MINUTES.toMillis(15) && job.backoffPolicy == JobInfo.BACKOFF_POLICY_LINEAR);
        new UpdateReceiver().onReceive(new Context(), new Intent(Intent.ACTION_BOOT_COMPLETED));
        check(scheduler.schedules == 1);
    }

    private static void idle() throws Exception {
        reset();
        check(run());
        check(UpdateEngine.applied.size() == 1);
        Object[] call = UpdateEngine.applied.get(0);
        check(call[0].equals("https://updates.example/ota.zip") && call[1].equals(41L) && call[2].equals(1000L));
        check(Arrays.equals((String[]) call[3], new String[] {"FILE_HASH=aA==", "FILE_SIZE=1000", "METADATA_HASH=bQ==", "METADATA_SIZE=12", "NETWORK_ID=123456789"}));
        check("downloading".equals(state()));
        check(Device.stored.get("sequence.beta").equals(5L) && Device.notifications.isEmpty() && UpdateEngine.unbinds == 1);
        check(durableAtApply.get("sequence.beta").equals(5L));

        String installId = (String) Device.stored.get("installId");
        check(installId != null);
        check(run());
        check(installId.equals(Device.stored.get("installId")));

        reset();
        publish(manifest(5, 100, BUILT));
        check(!run());
        check("up-to-date".equals(state()) && UpdateEngine.applied.isEmpty());
    }

    private static void working() throws Exception {
        for (int status : new int[] {UpdateStatusConstants.DOWNLOADING, UpdateStatusConstants.VERIFYING, UpdateStatusConstants.FINALIZING}) {
            reset();
            UpdateEngine.status = status;
            check(run());
            check("downloading".equals(state()) && Device.fetched.isEmpty() && UpdateEngine.applied.isEmpty() && Device.notifications.isEmpty());
        }
    }

    /** The merge after a restart: update_engine reports its end as a successful application, which is no new update. */
    private static void merging() throws Exception {
        reset();
        UpdateEngine.status = 11;
        UpdateEngine.outcome = ErrorCodeConstants.SUCCESS;
        check(run());
        check("up-to-date".equals(state()) && Device.fetched.isEmpty() && UpdateEngine.applied.isEmpty() && Device.notifications.isEmpty());
    }

    /** The job, and so its wake lock, lasts until update_engine finishes or JobScheduler stops it. */
    private static void held() throws Exception {
        for (int status : new int[] {UpdateStatusConstants.IDLE, UpdateStatusConstants.DOWNLOADING}) {
            reset();
            UpdateEngine.status = status;
            UpdateEngine.outcome = null;
            check(new UpdateJob().onStartJob(new JobParameters()));
            check(Device.finished.poll(200, TimeUnit.MILLISECONDS) == null);
            while (UpdateEngine.callback == null) Thread.onSpinWait();
            UpdateEngine.callback.onPayloadApplicationComplete(ErrorCodeConstants.SUCCESS);
            check(Boolean.FALSE.equals(Device.finished.poll(10, TimeUnit.SECONDS)));
            check("ready".equals(state()) && Device.notifications.size() == 1 && UpdateEngine.unbinds == 1);
        }
        reset();
        UpdateEngine.status = UpdateStatusConstants.DOWNLOADING;
        UpdateEngine.outcome = null;
        UpdateJob job = new UpdateJob();
        JobParameters params = new JobParameters();
        check(job.onStartJob(params));
        check(job.onStopJob(params));
        check(Boolean.TRUE.equals(Device.finished.poll(10, TimeUnit.SECONDS)));
        check(Device.notifications.isEmpty() && UpdateEngine.unbinds == 1);
    }

    /** A stop does not end socket I/O, so the check runs on; it must not start update_engine, and the next run does. */
    private static void stopped() throws Exception {
        for (boolean duringFetch : new boolean[] {true, false}) {
            reset();
            UpdateJob job = new UpdateJob();
            JobParameters params = new JobParameters();
            Runnable stop = () -> job.onStopJob(params);
            if (duringFetch) Device.fetching = stop;
            else Device.committed = stop;
            check(job.onStartJob(params));
            check(Device.finished.poll(10, TimeUnit.SECONDS) != null);
            check(UpdateEngine.applied.isEmpty() && Device.notifications.isEmpty() && UpdateEngine.unbinds == 1);
            Device.fetching = null;
            Device.committed = null;
            check(run());
            check(UpdateEngine.applied.size() == 1);
        }
    }

    private static void ready() throws Exception {
        reset();
        UpdateEngine.status = UpdateStatusConstants.UPDATED_NEED_REBOOT;
        check(!run());
        check("ready".equals(state()) && Device.fetched.isEmpty() && Device.notifications.size() == 1);
        android.app.Notification notification = Device.notifications.get(0);
        check("Update ready".contentEquals(notification.title) && notification.actions.size() == 1 && "Restart".contentEquals(notification.actions.get(0).title));
        check(((NotificationManager) Device.services.get(NotificationManager.class)).channel.importance == NotificationManager.IMPORTANCE_LOW);
        check(UpdateReceiver.ACTION_RESTART.equals(notification.actions.get(0).intent.intent.getAction()));
    }

    private static void failures() throws Exception {
        reset();
        Device.channel.remove(CHANNEL);
        quietFailure(run());
        reset();
        Device.channel.remove(CHANNEL + ".sig");
        quietFailure(run());
        reset();
        Device.channel.get(CHANNEL + ".sig")[0] ^= 1;
        quietFailure(run());
        check(!Device.stored.containsKey("sequence.beta"));
        reset();
        Device.commitFails = true;
        quietFailure(run());
        check(!Device.durable.containsKey("sequence.beta"));
        reset();
        publishSized(ChannelManifest.MAX_BYTES + 1);
        quietFailure(run());
        reset();
        publishSized(ChannelManifest.MAX_BYTES);
        check(run());
        check(UpdateEngine.applied.size() == 1);
        reset();
        UpdateEngine.denied = true;
        quietFailure(run());
        reset();
        UpdateEngine.applyFailure = new ServiceSpecificException(1);
        check(!run());
        check(Device.notifications.isEmpty() && state() == null);
        check(UpdateEngine.unbinds == 1);
    }

    private static void halt() throws Exception {
        reset();
        publish(manifest(8, 0, BUILT + 1));
        check(!run());
        check(UpdateEngine.applied.isEmpty() && "up-to-date".equals(state()) && Device.stored.get("sequence.beta").equals(8L));
        // A power cut right after the halt: only what reached the disk comes back.
        Device.stored.clear();
        Device.stored.putAll(Device.durable);
        publish(manifest(5, 100, BUILT + 1));
        quietReplay();
        publish(manifest(9, 100, BUILT + 1));
        check(run());
        check(UpdateEngine.applied.size() == 1 && Device.stored.get("sequence.beta").equals(9L));
    }

    private static void quietReplay() throws Exception {
        check(!run());
        check(UpdateEngine.applied.isEmpty() && Device.notifications.isEmpty() && Device.stored.get("sequence.beta").equals(8L));
    }

    private static void tapRestart() {
        new UpdateReceiver().onReceive(new Context(), new Intent(UpdateReceiver.ACTION_RESTART));
    }

    /** "Update ready" is up and Restart is tapped: nothing restarts and the notification stays. */
    private static void restartRefused() throws Exception {
        UpdateEngine.status = UpdateStatusConstants.UPDATED_NEED_REBOOT;
        run();
        tapRestart();
        check(Device.reboots.isEmpty() && Device.notifications.size() == 1 && "ready".equals(state()));
    }

    private static void restart() throws Exception {
        reset();
        tapRestart();
        check(Device.reboots.equals(java.util.List.of("null")));
        for (int mode : new int[] {AudioManager.MODE_RINGTONE, AudioManager.MODE_IN_CALL, AudioManager.MODE_IN_COMMUNICATION,
                AudioManager.MODE_CALL_SCREENING, AudioManager.MODE_CALL_REDIRECT, AudioManager.MODE_COMMUNICATION_REDIRECT}) {
            reset();
            Device.audioMode = mode;
            restartRefused();
        }
        // Silent, vibrating or Do Not Disturb: the call rings and the mode stays normal. Once it ends, Restart works.
        reset();
        Device.inCall = true;
        restartRefused();
        Device.inCall = false;
        tapRestart();
        check(Device.reboots.equals(java.util.List.of("null")));
        // The same ring with its app-op refused: isInCall reads false, so that answer must never be read.
        reset();
        Device.inCall = true;
        Device.phoneStateOpAllowed = false;
        restartRefused();
        // The permission revoked: isInCall throws.
        reset();
        Device.phoneStateGranted = false;
        restartRefused();
        reset();
        Device.services.remove(TelecomManager.class);
        restartRefused();
    }

    private static void status() throws Exception {
        reset();
        try {
            new StatusProvider().call("status", null, null);
            throw new AssertionError("Status without permission");
        } catch (SecurityException expected) {
            checks++;
        }
        Device.callerPermissions.add(READ_STATUS);
        Bundle before = new StatusProvider().call("status", null, null);
        check(before.getString(UpdateJob.STATE) == null && "20261102.1".equals(before.getString("version")));
        UpdateEngine.status = UpdateStatusConstants.IDLE;
        run();
        Bundle after = new StatusProvider().call("status", null, null);
        check("downloading".equals(after.getString(UpdateJob.STATE)) && "20261102.1".equals(after.getString("version")));
        try {
            new StatusProvider().call("restart", null, null);
            throw new AssertionError("Unknown method accepted");
        } catch (IllegalArgumentException expected) {
            checks++;
        }
    }

    public static void main(String[] args) throws Exception {
        keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        Device.strings.put(R.string.channel, "beta");
        Device.strings.put(R.string.channel_manifest_url, CHANNEL);
        Device.strings.put(R.string.channel_key, Base64.getEncoder().encodeToString(keys.getPublic().getEncoded()));
        Build.DEVICE = "stallion";
        Build.FINGERPRINT = BOOTED;
        Build.TIME = BUILT * 1000;
        Build.VERSION.INCREMENTAL = "20261102.1";
        schedule();
        idle();
        working();
        merging();
        held();
        stopped();
        ready();
        failures();
        halt();
        restart();
        status();
        System.out.println("PASS " + checks + " checks");
    }
}
