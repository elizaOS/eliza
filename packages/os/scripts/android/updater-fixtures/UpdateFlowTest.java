package ai.elizaos.updater;

import android.Device;
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
import android.os.UpdateEngine.UpdateStatusConstants;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;
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

    private static void check(boolean value) {
        if (!value) throw new AssertionError("Check " + checks);
        checks++;
    }

    private static void publish(long sequence, int rollout, long date) throws Exception {
        byte[] manifest = ("{\"schema\":1,\"channel\":\"beta\",\"device\":\"stallion\",\"version\":\"1.0.0\",\"sequence\":" + sequence
            + ",\"buildFingerprint\":\"" + NEXT + "\",\"buildDateUtc\":" + date + ",\"rolloutPercent\":" + rollout
            + ",\"updates\":[{\"from\":null,\"url\":\"https://updates.example/ota.zip\",\"payload\":{\"offset\":41,\"size\":1000,"
            + "\"properties\":[\"FILE_HASH=aA==\",\"FILE_SIZE=1000\",\"METADATA_HASH=bQ==\",\"METADATA_SIZE=12\"]}}]}").getBytes(StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(keys.getPrivate());
        signer.update(manifest);
        Device.channel.put(CHANNEL, manifest);
        Device.channel.put(CHANNEL + ".sig", signer.sign());
    }

    private static void reset() throws Exception {
        Device.stored.clear();
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
        Device.audioMode = AudioManager.MODE_NORMAL;
        Device.services.put(JobScheduler.class, new JobScheduler());
        Device.services.put(NotificationManager.class, new NotificationManager());
        Device.services.put(AudioManager.class, new AudioManager());
        Device.services.put(PowerManager.class, new PowerManager());
        publish(5, 100, BUILT + 1);
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
        check("downloading".equals(state()) && "1.0.0".equals(Device.stored.get(UpdateJob.VERSION)));
        check(Device.stored.get("sequence.beta").equals(5L) && Device.notifications.isEmpty() && UpdateEngine.unbinds == 1);

        String installId = (String) Device.stored.get("installId");
        check(installId != null);
        check(run());
        check(installId.equals(Device.stored.get("installId")));

        reset();
        publish(5, 100, BUILT);
        check(!run());
        check("up-to-date".equals(state()) && "20261102.1".equals(Device.stored.get(UpdateJob.VERSION)) && UpdateEngine.applied.isEmpty());
    }

    private static void working() throws Exception {
        for (int status : new int[] {UpdateStatusConstants.DOWNLOADING, UpdateStatusConstants.VERIFYING, UpdateStatusConstants.FINALIZING, 11}) {
            reset();
            UpdateEngine.status = status;
            check(run());
            check("downloading".equals(state()) && Device.fetched.isEmpty() && UpdateEngine.applied.isEmpty());
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
        Device.channel.put(CHANNEL, new byte[ChannelManifest.MAX_BYTES + 1]);
        quietFailure(run());
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
        publish(8, 0, BUILT + 1);
        check(!run());
        check(UpdateEngine.applied.isEmpty() && "up-to-date".equals(state()) && Device.stored.get("sequence.beta").equals(8L));
        publish(5, 100, BUILT + 1);
        quietReplay();
        publish(9, 100, BUILT + 1);
        check(run());
        check(UpdateEngine.applied.size() == 1 && Device.stored.get("sequence.beta").equals(9L));
    }

    private static void quietReplay() throws Exception {
        check(!run());
        check(UpdateEngine.applied.isEmpty() && Device.notifications.isEmpty() && Device.stored.get("sequence.beta").equals(8L));
    }

    private static void restart() throws Exception {
        reset();
        new UpdateReceiver().onReceive(new Context(), new Intent(UpdateReceiver.ACTION_RESTART));
        check(Device.reboots.equals(java.util.List.of("null")));
        for (int mode : new int[] {AudioManager.MODE_RINGTONE, AudioManager.MODE_IN_CALL, AudioManager.MODE_IN_COMMUNICATION,
                AudioManager.MODE_CALL_SCREENING, AudioManager.MODE_CALL_REDIRECT, AudioManager.MODE_COMMUNICATION_REDIRECT}) {
            reset();
            Device.audioMode = mode;
            UpdateEngine.status = UpdateStatusConstants.UPDATED_NEED_REBOOT;
            run();
            new UpdateReceiver().onReceive(new Context(), new Intent(UpdateReceiver.ACTION_RESTART));
            check(Device.reboots.isEmpty() && Device.notifications.size() == 1 && "ready".equals(state()));
        }
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
        check(before.getString(UpdateJob.STATE) == null);
        UpdateEngine.status = UpdateStatusConstants.IDLE;
        run();
        Bundle after = new StatusProvider().call("status", null, null);
        check("downloading".equals(after.getString(UpdateJob.STATE)) && "1.0.0".equals(after.getString(UpdateJob.VERSION)));
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
        ready();
        failures();
        halt();
        restart();
        status();
        System.out.println("PASS " + checks + " checks");
    }
}
