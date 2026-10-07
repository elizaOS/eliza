/**
 * Presents native Clock consent and retires it with the foreground Activity owner.
 * The host must wire its authenticated execution-claim lookup and owner fence here;
 * this class is deliberately not a renderer-callable approval or enrollment endpoint.
 */
package ai.elizaos.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Application;
import android.os.Bundle;
import android.os.Looper;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.FileDescriptor;
import java.io.IOException;
import java.nio.file.Path;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

final class ClockReviewDialog implements AutoCloseable, Application.ActivityLifecycleCallbacks {
    interface OwnerFence {
        void assertCurrent();
        /** The host must block owner replacement until failed cancellations are reconciled. */
        void retirementFailed(Exception error);
    }
    interface Callback {
        void completed(ClockConsentCoordinator.Result result, String reviewToken);
        void failed(Exception error);
    }
    interface NativeExecution {
        ClockHandoff.Effect dispatch(ClockConsentCoordinator.Identity identity, ClockHandoff.Request request,
                                        ClockHandoff.ApprovedConsent consent) throws Exception;
    }
    interface ClaimedPreparation {
        /** Start asynchronous authenticated server approval/claim after this native gesture. */
        void prepare(Completion completion);
        interface Completion { void ready(); void failed(Exception error); }
    }
    private static final class Pending {
        final ClockConsentCoordinator.Identity identity;
        final Callback callback;
        AlertDialog dialog;
        Pending(ClockConsentCoordinator.Identity identity, Callback callback) {
            this.identity = identity; this.callback = callback;
        }
    }
    private final Activity activity;
    private final ClockConsentCoordinator coordinator;
    private final OwnerFence owner;
    private final NativeExecution execution;
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private final Map<String, ClockConsentCoordinator.Identity> active = new LinkedHashMap<>();
    private boolean retired;

    ClockReviewDialog(Activity activity, ClockConsentCoordinator coordinator, OwnerFence owner) {
        this(activity, coordinator, owner, (identity, request, consent) ->
                new ClockHandoff.Effect(ClockHandoff.dispatch(activity, request, consent), null));
    }
    ClockReviewDialog(Activity activity, ClockConsentCoordinator coordinator, OwnerFence owner, NativeExecution execution) {
        this.activity = Objects.requireNonNull(activity);
        this.coordinator = Objects.requireNonNull(coordinator);
        this.owner = Objects.requireNonNull(owner);
        this.execution = Objects.requireNonNull(execution);
        current();
        activity.getApplication().registerActivityLifecycleCallbacks(this);
    }

    /** The native host creates this with no-backup private storage, never a renderer path. */
    static ClockConsentCoordinator coordinator(Activity activity, String nativeOwner,
                                               ClockConsentCoordinator.ApprovedLookup authority) throws IOException {
        Path directory = activity.getNoBackupFilesDir().getCanonicalFile().toPath().resolve("clock-consent");
        return new ClockConsentCoordinator(directory, nativeOwner, authority, ClockReviewDialog::syncDirectory,
                System::currentTimeMillis);
    }

    void reviewClock(ClockConsentCoordinator.Identity identity, ClockHandoff.Request request, Callback callback) {
        Pending review = new Pending(identity, Objects.requireNonNull(callback));
        String key = key(identity);
        ClockConsentCoordinator.Review state;
        boolean prepared = false;
        try {
            current();
            if (pending.containsKey(key)) throw new IllegalStateException("Clock native review already pending");
            request.requireCurrentTimeZone(ZoneId.systemDefault().getId());
            state = coordinator.reviewClock(identity, request);
            prepared = true;
            if (state.result == null) active.put(key, identity);
            current();
            if (state.result == null) {
                pending.put(key, review);
                review.dialog = new AlertDialog.Builder(activity)
                        .setTitle("Review Clock request")
                        .setMessage(description(state.request))
                        .setPositiveButton(positiveLabel(request), (dialog, which) -> approve(review, state.request))
                        .setNegativeButton("Cancel", (dialog, which) -> cancel(review))
                        .setOnCancelListener(dialog -> cancel(review))
                        .create();
                review.dialog.show();
            }
        } catch (IOException | RuntimeException error) {
            // error-policy:J1 native review boundary returns the failure to its host bridge.
            if (pending.get(key) == review) pending.remove(key);
            if (prepared) cancelAfterFailure(identity, error);
            if (review.dialog != null) review.dialog.dismiss();
            callback.failed(error);
            return;
        }
        if (state.result != null) callback.completed(state.result, null);
    }

    /** Present a pending server proposal once; preparation runs off-thread and returns to this Activity. */
    void reviewPending(ClockConsentCoordinator.Identity identity, ClockHandoff.Request request, String scopeDescription,
                       ClaimedPreparation preparation, Callback callback) {
        Pending review = new Pending(identity, Objects.requireNonNull(callback));
        String key = key(identity);
        try {
            current(); request.requireCurrentTimeZone(ZoneId.systemDefault().getId());
            if (pending.containsKey(key) || active.containsKey(key)) throw new IllegalStateException("Clock native review already pending");
            pending.put(key, review); active.put(key, identity);
            review.dialog = new AlertDialog.Builder(activity).setTitle("Review Clock request")
                    .setMessage(description(request) + "\n\n" + scopeDescription)
                    .setPositiveButton(positiveLabel(request), (dialog, which) -> {
                        try {
                            current(); request.requireCurrentTimeZone(ZoneId.systemDefault().getId());
                            preparation.prepare(new ClaimedPreparation.Completion() {
                                @Override public void ready() { activity.runOnUiThread(() -> claimed(review, request)); }
                                @Override public void failed(Exception error) { activity.runOnUiThread(() -> preparationFailed(review, error)); }
                            });
                        } catch (RuntimeException error) {
                            // error-policy:J1 stale gestures cannot authorize a server decision.
                            preparationFailed(review, error);
                        }
                    }).setNegativeButton("Cancel", (dialog, which) -> cancel(review))
                    .setOnCancelListener(dialog -> cancel(review)).create();
            review.dialog.show();
        } catch (RuntimeException error) {
            // error-policy:J1 native presentation failures settle the renderer call.
            if (pending.get(key) == review) { pending.remove(key); active.remove(key); }
            callback.failed(error);
        }
    }
    private void claimed(Pending review, ClockHandoff.Request request) {
        if (pending.get(key(review.identity)) != review) return;
        try {
            current();
            ClockConsentCoordinator.Review state = coordinator.reviewClock(review.identity, request);
            if (state.result != null) {
                pending.remove(key(review.identity)); active.remove(key(review.identity));
                review.callback.completed(state.result, null);
            } else approve(review, request);
        } catch (IOException | RuntimeException error) {
            // error-policy:J1 failed admission must cancel native consent before reporting.
            preparationFailed(review, error);
        }
    }
    private void preparationFailed(Pending review, Exception error) {
        if (pending.remove(key(review.identity)) != review) return;
        cancelAfterFailure(review.identity, error); review.callback.failed(error);
    }

    private void approve(Pending review, ClockHandoff.Request request) {
        if (pending.remove(key(review.identity)) != review) return;
        String token;
        try {
            current();
            request.requireCurrentTimeZone(ZoneId.systemDefault().getId());
            token = coordinator.approveFromNativeGesture(review.identity, request);
            current();
        } catch (IOException | RuntimeException error) {
            // error-policy:J1 rejected native gestures cancel before reporting to the host.
            cancelAfterFailure(review.identity, error);
            review.callback.failed(error);
            return;
        }
        review.callback.completed(null, token);
    }

    void confirmClock(ClockConsentCoordinator.Identity identity, String token, Callback callback) {
        confirmClock(identity, token, callback, () -> {});
    }
    void confirmClock(ClockConsentCoordinator.Identity identity, String token, Callback callback, Runnable dispatchFence) {
        ClockConsentCoordinator.Result result;
        try {
            current();
            result = coordinator.confirmClock(identity, token, new ClockConsentCoordinator.Dispatcher() {
                private String receipt;
                @Override public ClockHandoff.Outcome dispatch(ClockHandoff.Request request, ClockHandoff.ApprovedConsent consent) {
                    current(); dispatchFence.run();
                    try {
                        ClockHandoff.Effect effect = execution.dispatch(identity, request, reviewed -> {
                            current(); dispatchFence.run(); consent.consume(reviewed);
                        });
                        receipt = effect.receipt; return effect.outcome;
                    } catch (RuntimeException error) { throw error; }
                    catch (Exception error) { throw new IllegalStateException("Native alarm effect failed", error); }
                }
                @Override public String receipt() { return receipt; }
            });
            active.remove(key(identity));
            current();
        } catch (IOException | RuntimeException error) {
            // error-policy:J1 the host observes authority, durability and foreground failures.
            callback.failed(error);
            return;
        }
        callback.completed(result, null);
    }

    void cancelClock(ClockConsentCoordinator.Identity identity) throws IOException {
        mainThread();
        coordinator.cancelClock(identity);
        active.remove(key(identity));
        Pending review = pending.remove(key(identity));
        if (review != null) {
            review.dialog.dismiss();
            review.callback.completed(ClockConsentCoordinator.Result.DENIED, null);
        }
    }

    private void cancel(Pending review) {
        if (pending.remove(key(review.identity)) != review) return;
        try { coordinator.cancelClock(review.identity); active.remove(key(review.identity)); }
        catch (IOException | RuntimeException error) {
            // error-policy:J1 cancellation failure remains observable, never a successful acknowledgement.
            review.callback.failed(error); return;
        }
        review.callback.completed(ClockConsentCoordinator.Result.DENIED, null);
    }

    @Override public void close() throws IOException {
        mainThread();
        retired = true;
        IOException failure = null;
        try { activity.getApplication().unregisterActivityLifecycleCallbacks(this); }
        catch (RuntimeException error) {
            // error-policy:J2 lifecycle failure must not prevent durable cancellation attempts.
            failure = new IOException("Clock lifecycle retirement failed", error);
        }
        for (ClockConsentCoordinator.Identity identity : new ArrayList<>(active.values())) {
            try { cancelClock(identity); }
            catch (IOException | RuntimeException error) {
                // error-policy:J2 retirement reports all failed durable cancellations to the host.
                if (failure == null) failure = new IOException("Clock review retirement failed", error);
                else failure.addSuppressed(error);
            }
        }
        if (failure != null) {
            owner.retirementFailed(failure);
            throw failure;
        }
    }

    private void current() {
        mainThread();
        if (retired || activity.isFinishing() || activity.isDestroyed())
            throw new SecurityException("Clock foreground owner retired");
        owner.assertCurrent();
    }
    private static void mainThread() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Clock review requires Activity thread");
    }
    private static String key(ClockConsentCoordinator.Identity identity) {
        return identity.scope + ":" + identity.proposalId + ":" + identity.operationId;
    }
    static String description(ClockHandoff.Request request) {
        if (request.owned) return ownedDescription(request);
        switch (request.action) {
            case SET:
                String repeat = "Once (no repeat days)";
                if (request.days != null && !request.days.isEmpty()) {
                    String[] names = {"", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"};
                    ArrayList<String> selected = new ArrayList<>();
                    for (int day : request.days) selected.add(names[day]);
                    repeat = String.join(", ", selected) + " (every week)";
                }
                return String.format(Locale.ROOT, "Set alarm for %02d:%02d\nRepeat: %s\nLabel: %s\nPhone timezone: %s\n\nOpening Clock may set or update the alarm immediately. Clock owns this alarm and its repeat schedule. No second confirmation is guaranteed.",
                        request.hour, request.minute, repeat, request.label, request.timeZone);
            case SHOW: return "Open the external Clock alarm list. This app cannot confirm alarm state.";
            case DISMISS: return "Ask the external Clock app to dismiss alarms. No specific alarm is selected; Clock determines the affected alarms, which may include all ringing alarms. It may act immediately. No second confirmation is guaranteed.";
            case SNOOZE: return "Ask the external Clock app to snooze ringing alarms for " + request.snoozeMinutes
                    + " minutes. No specific alarm is selected; this may affect all ringing alarms. Clock may use its default duration or show a chooser, and may act immediately. No second confirmation is guaranteed.";
            default: throw new IllegalArgumentException("Unsupported Clock request");
        }
    }
    static String positiveLabel(ClockHandoff.Request request) {
        if (!request.owned) return "Open Clock";
        switch (request.action) {
            case SET: return "Save alarm";
            case UPDATE: return "Save changes";
            case DELETE: return "Delete alarm";
            case ENABLE: return request.enabled ? "Enable alarm" : "Disable alarm";
            case DISMISS: return "Stop alarm";
            case SNOOZE: return "Snooze alarm";
            case SHOW: return "Show alarms";
            default: throw new IllegalArgumentException("Unsupported alarm action");
        }
    }
    private static String ownedDescription(ClockHandoff.Request request) {
        switch (request.action) {
            case SET:
            case UPDATE:
                String consequence = request.action == ClockHandoff.Action.SET
                        ? "Eliza schedules and rings this alarm on this phone."
                        : "Replace this alarm's time, repeat days and label. Keep its enabled or disabled state. Stop its current ringing or snoozed occurrence.";
                return String.format(Locale.ROOT, "%s for %02d:%02d\nRepeat: %s\nLabel: %s\nTimezone: %s\n\n%s",
                        request.action == ClockHandoff.Action.SET ? "Set alarm" : "Update alarm", request.hour, request.minute,
                        repeatDescription(request.days), request.label.isEmpty() ? "Alarm" : request.label, request.timeZone, consequence);
            case SHOW: return "Show your Eliza alarms on this phone.";
            case DELETE: return "Delete this Eliza alarm and cancel its scheduled and ringing occurrences.";
            case ENABLE: return request.enabled ? "Enable this Eliza alarm." : "Disable this Eliza alarm and stop its current occurrence.";
            case DISMISS: return "Stop this ringing Eliza alarm. Its next repeating occurrence stays scheduled.";
            case SNOOZE: return "Snooze this ringing Eliza alarm for " + request.snoozeMinutes + " minutes.";
            default: throw new IllegalArgumentException("Unsupported alarm action");
        }
    }
    static String repeatDescription(java.util.List<Integer> days) {
        if (days == null || days.isEmpty()) return "Once";
        String[] names = {"", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"};
        ArrayList<String> selected = new ArrayList<>();
        for (int day : days) selected.add(names[day]);
        return String.join(", ", selected) + " (every week)";
    }
    private void cancelAfterFailure(ClockConsentCoordinator.Identity identity, Exception failure) {
        try { coordinator.cancelClock(identity); active.remove(key(identity)); }
        catch (IOException | RuntimeException error) {
            // error-policy:J2 report both the original failure and failed cancellation.
            failure.addSuppressed(error);
        }
    }
    private static void syncDirectory(Path directory) throws IOException {
        try {
            FileDescriptor descriptor = Os.open(directory.toString(), OsConstants.O_RDONLY, 0);
            try { Os.fsync(descriptor); } finally { Os.close(descriptor); }
        } catch (ErrnoException error) {
            // error-policy:J2 durability failure must prevent native dispatch.
            throw new IOException("Clock directory sync failed", error);
        }
    }
    @Override public void onActivityPaused(Activity paused) {
        if (paused != activity) return;
        try { close(); }
        catch (IOException | RuntimeException error) {
            // error-policy:J1 Activity retirement must surface failed durable consent cancellation.
            for (Pending review : new ArrayList<>(pending.values())) {
                pending.remove(key(review.identity));
                try { review.dialog.dismiss(); review.callback.failed(error); }
                catch (RuntimeException callbackFailure) {
                    // error-policy:J2 one failed UI callback must not hide other cancellation failures.
                    error.addSuppressed(callbackFailure);
                }
            }
            if (!(error instanceof IOException)) owner.retirementFailed(error);
        }
    }
    @Override public void onActivityDestroyed(Activity destroyed) { onActivityPaused(destroyed); }
    @Override public void onActivityCreated(Activity created, Bundle state) { }
    @Override public void onActivityStarted(Activity started) { }
    @Override public void onActivityResumed(Activity resumed) { }
    @Override public void onActivityStopped(Activity stopped) { }
    @Override public void onActivitySaveInstanceState(Activity saved, Bundle state) { }
}
