// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.content.res.AssetFileDescriptor;
import android.os.Handler;
import android.os.Looper;
import android.os.UpdateEngine;
import android.os.UpdateEngineCallback;
import android.util.Log;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/** The only applyPayload call site. Journal intent precedes the Binder effect. */
final class EngineInstaller {
    enum Result { DEFERRED, REBOOT_READY, FAILED, UNKNOWN }
    interface Listener { void complete(Result result, String message); }

    private final JournalStore journal;
    private final Executor serial;
    private final Supplier<String> currentBoot;
    private UpdateEngine engine;
    private volatile int engineStatus = -1;
    private boolean ownsAttempt;
    private String attemptBoot;
    private Listener listener;

    EngineInstaller(JournalStore journal, Executor serial, Supplier<String> currentBoot) {
        this.journal = journal; this.serial = serial; this.currentBoot = currentBoot;
    }

    static UpdateAdmission.Engine engineOf(int status) {
        if (status == UpdateEngine.UpdateStatusConstants.IDLE) return UpdateAdmission.Engine.IDLE;
        if (status == UpdateEngine.UpdateStatusConstants.UPDATED_NEED_REBOOT) return UpdateAdmission.Engine.NEEDS_REBOOT;
        return status < 0 ? UpdateAdmission.Engine.UNAVAILABLE : UpdateAdmission.Engine.BUSY;
    }

    /** Called on the host's serial worker; listener calls use that same worker. */
    // spec/os/update/updater.md, "An apply intent is persisted before the one apply call, and only for a verified candidate the offer still matches"
    void apply(VerifiedPayload payload, Supplier<UpdateAdmission.Conditions> conditions,
            UpdateAdmission.Offer offer, Listener listener) {
        if (engine != null || ownsAttempt) {
            listener.complete(Result.DEFERRED, "An update operation is already attached");
            return;
        }
        this.listener = listener;
        CountDownLatch observed = new CountDownLatch(1);
        try {
            UpdateJournal before = journal.read();
            if (before.phase != UpdateJournal.Phase.VERIFIED
                    || !before.targetBuild.equals(payload.release.fingerprint())
                    || !before.packageSha256.equals(payload.otaSha256)) {
                throw new IOException("Payload differs from the verified journal");
            }
            engine = new UpdateEngine();
            boolean bound = engine.bind(new UpdateEngineCallback() {
                @Override public void onStatusUpdate(int status, float progress) {
                    engineStatus = status;
                    observed.countDown();
                }
                @Override public void onPayloadApplicationComplete(int errorCode) {
                    serial.execute(() -> applied(errorCode));
                }
            }, new Handler(Looper.getMainLooper()));
            if (!bound || !observed.await(10, TimeUnit.SECONDS)) {
                finish(Result.DEFERRED, "Update engine did not provide a current status");
                return;
            }
            attemptBoot = currentBoot.get();
            final UpdateJournal intent;
            try {
                intent = before.applyIntent(attemptBoot, engineOf(engineStatus), conditions.get(), offer);
            } catch (IllegalStateException held) {
                finish(Result.DEFERRED, "Waiting for update conditions");
                return;
            }
            journal.write(before, intent);
            String boot = currentBoot.get();
            UpdateAdmission.Conditions now = conditions.get();
            if (intent.applyIntentStale(boot, now)) {
                // No Binder apply was made. Return to the verified state only if the intent is still ours.
                journal.write(intent, intent.withdrawApplyIntent(boot, now));
                finish(Result.DEFERRED, "Update conditions changed before apply");
                return;
            }
            ownsAttempt = true;
            // The descriptor is duplicated by Binder. No shared writable path is given to the engine.
            try (AssetFileDescriptor fd = payload.open()) {
                engine.applyPayload(fd, payload.headers());
            }
            journal.write(intent, intent.applying(attemptBoot));
        } catch (Exception failure) {
            boolean uncertain = ownsAttempt;
            if (uncertain) unknown();
            finish(uncertain ? Result.UNKNOWN : Result.DEFERRED,
                    uncertain ? "Update apply result is not confirmed" : "Update could not start");
        }
    }

    // spec/os/update/updater.md, "Only the attempt's own result ends an apply, and a stopped job never cancels it"
    private void applied(int errorCode) {
        if (!ownsAttempt) return;
        try {
            UpdateJournal before = journal.read();
            UpdateJournal after = before.completedApply(currentBoot.get(), errorCode);
            journal.write(before, after);
            ownsAttempt = false;
            finish(after.phase == UpdateJournal.Phase.REBOOT_READY ? Result.REBOOT_READY
                    : after.phase == UpdateJournal.Phase.FAILED ? Result.FAILED : Result.UNKNOWN,
                    after.phase == UpdateJournal.Phase.REBOOT_READY ? "OS update is ready to restart"
                            : "OS update did not finish");
        } catch (Exception unavailable) {
            unknown(); finish(Result.UNKNOWN, "Update completion needs reconciliation");
        }
    }

    static int observeStatus() throws IOException {
        UpdateEngine observed = new UpdateEngine();
        java.util.concurrent.atomic.AtomicInteger status = new java.util.concurrent.atomic.AtomicInteger(-1);
        CountDownLatch ready = new CountDownLatch(1);
        try {
            if (!observed.bind(new UpdateEngineCallback() {
                @Override public void onStatusUpdate(int value, float progress) { status.set(value); ready.countDown(); }
                @Override public void onPayloadApplicationComplete(int errorCode) { }
            }, new Handler(Looper.getMainLooper())) || !ready.await(10, TimeUnit.SECONDS)) {
                throw new IOException("Update engine status is unavailable");
            }
            return status.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Update observation cancelled", interrupted);
        } finally {
            try { observed.unbind(); }
            catch (RuntimeException failure) { Log.w("ElizaSystemUpdater", "Status observer unbind unconfirmed", failure); }
        }
    }

    /** Process-local detach never resubmits an uncertain request. */
    void detach() {
        boolean uncertain = ownsAttempt;
        if (uncertain) unknown();
        finish(uncertain ? Result.UNKNOWN : Result.DEFERRED, "Update observation ended");
    }

    private void unknown() {
        try {
            UpdateJournal before = journal.read();
            if (before.phase == UpdateJournal.Phase.APPLY_INTENT
                    || before.phase == UpdateJournal.Phase.APPLYING) {
                journal.write(before, before.reconcile(before.sourceBuild, currentBoot.get()));
            }
        } catch (Exception unavailable) {
            // Preserve the earlier durable apply intent; restart treats it as uncertain.
            Log.w("ElizaSystemUpdater", "Could not record uncertain update state", unavailable);
        }
        ownsAttempt = false;
    }

    private void finish(Result result, String message) {
        UpdateEngine attached = engine; engine = null;
        if (attached != null) {
            try { attached.unbind(); }
            catch (RuntimeException failure) { Log.w("ElizaSystemUpdater", "Engine unbind unconfirmed", failure); }
        }
        Listener completed = listener; listener = null;
        if (completed != null) completed.complete(result, message);
    }
}
