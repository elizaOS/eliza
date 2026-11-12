// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.UpdateEngine;
import android.os.UserManager;
import android.provider.Settings;
import android.telecom.TelecomManager;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** A single host worker owns discovery, verification, apply and reboot admission. */
final class UpdateRunner {
    private static UpdateRunner instance;
    private final Context context;
    private final ExecutorService serial = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private Run active;

    private static final class Run {
        final int job;
        final Runnable finished;
        volatile boolean stopped;
        Future<?> task;
        EngineInstaller installer;
        volatile boolean applying;
        boolean verifying;
        Run(int job, Runnable finished) { this.job = job; this.finished = finished; }
    }

    static synchronized UpdateRunner get(Context context) {
        if (instance == null) instance = new UpdateRunner(context.getApplicationContext());
        return instance;
    }

    private UpdateRunner(Context context) { this.context = context; }

    synchronized boolean start(int job, Runnable finished) {
        if (active != null) return false;
        Run run = active = new Run(job, finished);
        run.task = serial.submit(() -> execute(run));
        return true;
    }

    synchronized boolean stop(int job) {
        Run run = active;
        if (run == null || run.job != job) return false;
        run.stopped = true;
        // The update engine owns an accepted apply. Do not cancel or repeat it here.
        if (!run.applying) { run.task.cancel(true); active = null; return true; }
        return false;
    }

    static void status(Context context, String message) {
        context.getSharedPreferences("update-status", Context.MODE_PRIVATE).edit()
                .putString("message", message).apply();
        Log.i("ElizaSystemUpdater", message);
    }

    private void execute(Run run) {
        try {
            // Android exposes app storage through /data/user/0 as well as /data/data.
            // Bind the trusted framework directory once before validating child paths.
            File directory = context.getFilesDir().getCanonicalFile();
            JournalStore store = new JournalStore(directory);
            if (!context.getResources().getBoolean(R.bool.os_update_enabled)) {
                finish(run, "System updates are not configured"); return;
            }
            if (!downloadAllowed()) { finish(run, "Waiting for enough battery and an unmetered network"); return; }
            UpdateJournal current = store.read();
            UpdateJournal observed = current.reconcile(android.os.Build.FINGERPRINT, boot());
            if (observed != current) { store.write(current, observed); current = observed; }
            if (current.phase == UpdateJournal.Phase.UNKNOWN
                    || current.phase == UpdateJournal.Phase.FAILED
                    || current.phase == UpdateJournal.Phase.REBOOT_INTENT) {
                finish(run, "An earlier system update needs review"); return;
            }
            UpdateChannel channel = new UpdateChannel(context.getString(R.string.os_update_manifest),
                    context.getResources().getStringArray(R.array.os_update_hosts),
                    context.getString(R.string.os_update_product), context.getString(R.string.os_update_device));
            UpdateChannel.Candidate candidate = channel.discover();
            if (current.isUnapplied() && (candidate == null || !current.targetBuild.equals(candidate.fingerprint)
                    || !current.packageSha256.equals(candidate.sha256))) {
                UpdateJournal idle = current.cancelUnapplied();
                store.write(current, idle); current = idle;
            }
            if (candidate == null) { finish(run, "No newer system update was offered"); return; }
            if (current.phase == UpdateJournal.Phase.IDLE || current.phase == UpdateJournal.Phase.COMPLETE
                    || current.phase == UpdateJournal.Phase.SOURCE_RETAINED) {
                UpdateJournal next = current.download(android.os.Build.FINGERPRINT,
                        candidate.fingerprint, candidate.sha256);
                store.write(current, next); current = next;
            }
            if (!current.targetBuild.equals(candidate.fingerprint)
                    || !current.packageSha256.equals(candidate.sha256)) {
                finish(run, "The offered update changed; the earlier candidate remains held"); return;
            }
            boolean unapplied = current.isUnapplied();
            Path scratch = unapplied
                    ? PackageVerifier.reclaimExtractionScratch(directory.toPath()) : null;
            File ota = new File(directory, candidate.sha256 + ".zip");
            if (!ota.exists()) {
                if (current.phase != UpdateJournal.Phase.DOWNLOADING) {
                    finish(run, "The verified update package is unavailable"); return;
                }
                status(context, "Downloading system update");
                ota = channel.download(candidate, directory);
            }
            status(context, "Verifying system update");
            run.verifying = unapplied;
            VerifiedPayload payload = PackageVerifier.verify(ota, directory,
                    candidate.sha256, candidate.bytes, candidate.fingerprint, candidate.timestamp,
                    context.getString(R.string.os_update_product), context.getString(R.string.os_update_device),
                    context.getString(R.string.os_update_ota_certificate), scratch);
            run.verifying = false;
            if (current.phase == UpdateJournal.Phase.DOWNLOADING) {
                UpdateJournal next = current.verified(android.os.Build.FINGERPRINT,
                        payload.targetBuild, payload.otaSha256);
                store.write(current, next); current = next;
            }
            if (run.stopped) { finish(run, "System update check paused"); return; }
            if (current.phase == UpdateJournal.Phase.REBOOT_READY) {
                rebootIfAllowed(run, store, channel, candidate); return;
            }
            if (current.phase != UpdateJournal.Phase.VERIFIED || !installAllowed()) {
                SystemUpdateJob.schedule(context, true);
                finish(run, "System update will install when the phone is idle"); return;
            }
            if (!same(candidate, channel.discover())) {
                finish(run, "The update offer changed before installation"); return;
            }
            run.installer = new EngineInstaller(store, serial, this::boot);
            run.applying = true;
            status(context, "Installing system update");
            run.installer.apply(payload, () -> !run.stopped && installAllowed(), (result, message) -> {
                run.applying = false;
                if (result == EngineInstaller.Result.REBOOT_READY) {
                    try { rebootIfAllowed(run, store, channel, candidate); }
                    catch (Exception failure) { failure(run, failure); }
                } else finish(run, message);
            });
            main.postDelayed(() -> serial.execute(() -> {
                synchronized (UpdateRunner.this) { if (active != run || !run.applying) return; }
                run.installer.detach();
            }), 30 * 60_000L);
        } catch (Exception error) { failure(run, error); }
    }

    private void rebootIfAllowed(Run run, JournalStore store, UpdateChannel channel,
            UpdateChannel.Candidate candidate) throws IOException {
        if (run.stopped || !installAllowed() || !same(candidate, channel.discover())) {
            SystemUpdateJob.schedule(context, true);
            finish(run, "System update is ready; waiting for idle restart conditions"); return;
        }
        if (EngineInstaller.observeStatus() != UpdateEngine.UpdateStatusConstants.UPDATED_NEED_REBOOT) {
            finish(run, "System update engine state needs review"); return;
        }
        if (run.stopped || !installAllowed()) {
            SystemUpdateJob.schedule(context, true);
            finish(run, "Waiting for idle restart conditions"); return;
        }
        UpdateJournal current = store.read();
        UpdateJournal intent = current.rebootIntent(true, true);
        store.write(current, intent);
        if (run.stopped || !installAllowed()) {
            // The system reboot was not called; keep the verified ready state.
            store.write(intent, current);
            SystemUpdateJob.schedule(context, true);
            finish(run, "Restart conditions changed"); return;
        }
        status(context, "Restarting to finish the system update");
        PowerManager power = context.getSystemService(PowerManager.class);
        if (power == null) throw new IOException("Power service unavailable");
        power.reboot("system-update");
        finish(run, "System restart requested");
    }

    private boolean downloadAllowed() {
        UserManager users = context.getSystemService(UserManager.class);
        BatteryManager battery = context.getSystemService(BatteryManager.class);
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        DevicePolicyManager policy = context.getSystemService(DevicePolicyManager.class);
        if (users == null || !users.isSystemUser() || !users.isUserUnlocked() || users.isManagedProfile()
                || battery == null || (!battery.isCharging() && battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) < 50) || connectivity == null || policy == null
                || policy.getSystemUpdatePolicy() != null) return false;
        NetworkCapabilities network = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
        return network != null && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
    }

    private boolean installAllowed() {
        PowerManager power = context.getSystemService(PowerManager.class);
        TelecomManager phone = context.getSystemService(TelecomManager.class);
        if (!downloadAllowed() || power == null || power.isInteractive() || phone == null
                || context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return false;
        try { return !phone.isInCall(); }
        catch (SecurityException unavailable) { return false; }
    }

    private String boot() {
        int count = Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, -1);
        if (count < 0) throw new IllegalStateException("Boot identity unavailable");
        return "boot-" + count;
    }

    private static boolean same(UpdateChannel.Candidate first, UpdateChannel.Candidate next) {
        return next != null && first.sha256.equals(next.sha256)
                && first.fingerprint.equals(next.fingerprint) && first.timestamp == next.timestamp
                && first.bytes == next.bytes;
    }

    private void failure(Run run, Exception failure) {
        Log.w("ElizaSystemUpdater", "System update operation stopped", failure);
        if (run.verifying && !run.stopped) {
            try {
                JournalStore store = new JournalStore(context.getFilesDir());
                UpdateJournal before = store.read();
                if (failure instanceof PackageVerifier.StorageDeferred && before.isUnapplied()) {
                    finish(run, "Waiting for enough storage to verify the system update");
                    return;
                }
                store.write(before, before.failedBeforeApply());
            } catch (Exception unconfirmed) {
                Log.w("ElizaSystemUpdater", "Rejected-package state is unconfirmed", unconfirmed);
            }
        }
        if (failure instanceof UpdateChannel.DownloadDeferred && !run.stopped) SystemUpdateJob.schedule(context, true);
        finish(run, failure instanceof GeneralSecurityException
                ? "System update signature was refused" : "System update could not be completed; its state is retained");
    }

    private synchronized void finish(Run run, String message) {
        if (active != run) return;
        status(context, message); active = null;
        if (!run.stopped) main.post(run.finished);
    }
}
