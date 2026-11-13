package ai.elizaos.app;

import ai.eliza.plugins.system.clock.ClockDays;
import ai.eliza.plugins.system.clock.ClockHandoff;
import ai.eliza.plugins.system.clock.ClockProfile;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/**
 * Moves the alarms Eliza saved under its former owned-alarm profile to the phone's Clock app
 * ({@link ClockProfile.SavedAlarms#HAND_OFF_TO_CLOCK}) through the shared
 * {@code ai.eliza.plugins.system.clock.ClockHandoff}. The owner reviews each alarm in a native
 * dialog; no alarm content crosses into JavaScript. Opening Clock is not a receipt: an alarm is
 * retired only after the owner confirms it is saved in Clock (or chooses to remove it), and until
 * then {@link ElizaAlarms} keeps ringing it. The journal lives in {@link ElizaAlarmHandoff}.
 */
final class ElizaAlarmMigration {
    private static final String TAG = "ElizaAlarmMigration";
    /** The recorded owner decision for alarms saved before Eliza became handoff-only. */
    static final ClockProfile.SavedAlarms DECISION = ClockProfile.SavedAlarms.HAND_OFF_TO_CLOCK;

    /** Callback for one owner review; {@code outcome} is a stable wire word, {@code message} user text. */
    interface Done { void done(String outcome, String message); }

    private final Activity activity;
    private final BooleanSupplier foreground;
    private final Runnable changed;
    private AlertDialog dialog;
    private Done active;
    /** Clock was opened from this process for this attempt; confirm on return to the foreground. */
    private String awaiting;

    ElizaAlarmMigration(Activity activity, BooleanSupplier foreground, Runnable changed) {
        this.activity = activity; this.foreground = foreground; this.changed = changed;
    }

    static boolean active() {
        return SlotClockPlugin.CLOCK_PROFILE.savedAlarmsFrom(ClockProfile.OWNED_ALARMS, DECISION)
                == ClockProfile.SavedAlarms.HAND_OFF_TO_CLOCK;
    }

    /**
     * Boot and upgrade: start the journal once and re-arm alarms still waiting to move. Restoration
     * is the store's idempotent reconcile and never depends on the journal being readable.
     */
    static void restore(Context context) {
        if (!active()) return;
        ElizaAlarmHandoff.Summary summary = null;
        try { summary = ElizaAlarms.handoff(context, (state, now) -> { ElizaAlarmHandoff.begin(state, now); return ElizaAlarmHandoff.summary(state); }); }
        catch (RuntimeException error) {
            // error-policy:J1 a journal failure never stops saved alarms from ringing; restore below.
            Log.e(TAG, "Saved alarm handoff journal unavailable", error);
        }
        if (summary != null && summary.pending + summary.offered == 0) return;
        try { ElizaAlarms.reconcile(context, false); }
        catch (RuntimeException error) {
            // error-policy:J1 durable/platform failures remain explicit in native state and logs.
            Log.e(TAG, "Saved alarms could not be re-armed", error);
        }
    }

    /** Starts the journal once (the upgrade marker) without re-arming; for hosts with their own restore. */
    static void begin(Context context) {
        if (!active()) return;
        try { ElizaAlarms.handoff(context, (state, now) -> ElizaAlarmHandoff.begin(state, now)); }
        catch (RuntimeException error) {
            // error-policy:J1 a journal failure never stops saved alarms from ringing.
            Log.e(TAG, "Saved alarm handoff journal unavailable", error);
        }
    }

    /** Counts for the renderer: how many saved alarms still ring from Eliza, and how many moved. */
    static JSONObject status(Context context) throws Exception {
        if (!active()) return new JSONObject().put("active", false).put("pending", 0).put("awaitingConfirmation", 0).put("moved", 0).put("removed", 0);
        ElizaAlarmHandoff.Summary summary = ElizaAlarms.handoff(context, (state, now) -> { ElizaAlarmHandoff.begin(state, now); return ElizaAlarmHandoff.summary(state); });
        return new JSONObject().put("active", true).put("pending", summary.pending).put("awaitingConfirmation", summary.offered)
                .put("moved", summary.saved).put("removed", summary.removed);
    }

    boolean awaitingConfirmation() { return awaiting != null; }
    boolean reviewing() { return dialog != null; }

    /** Shows the next saved alarm: its confirmation if Clock was opened for it, otherwise its move. */
    void review(Done done) {
        if (dialog != null) { done.done("busy", "Another alarm review is open"); return; }
        ElizaAlarmHandoff.Entry entry;
        try {
            if (!active() || !foreground.getAsBoolean()) throw new SecurityException("Open Eliza before moving alarms");
            entry = ElizaAlarms.handoff(activity, (state, now) -> { ElizaAlarmHandoff.begin(state, now); return ElizaAlarmHandoff.next(state); });
        } catch (RuntimeException error) {
            // error-policy:J1 the owner sees a failed read; nothing is retired or launched.
            done.done("failed", "Saved alarms could not be read"); return;
        }
        if (entry == null) { awaiting = null; done.done("none", "No Eliza alarms are waiting to move"); return; }
        active = done;
        if (entry.offered()) confirm(entry); else offer(entry);
    }

    /** On return from Clock, ask once whether the alarm opened there was saved. */
    void resumed() {
        if (awaiting == null || dialog != null || !foreground.getAsBoolean()) return;
        review((outcome, message) -> { });
    }

    /** Leaving the foreground cancels an open review; an offered alarm stays offered and keeps ringing. */
    void paused() {
        AlertDialog open = dialog; dialog = null;
        if (open != null) open.dismiss();
        if (active != null) finish("cancelled", "Alarm review cancelled. Eliza keeps ringing the alarm.");
    }

    private void offer(ElizaAlarmHandoff.Entry entry) {
        String zone = ZoneId.systemDefault().getId();
        String message = "Eliza alarms now live in your phone's Clock app.\n\n" + describe(entry)
                + (entry.enabled ? "" : "\nState: Off in Eliza (Clock may save it turned on)")
                + "\n\nContinue to Clock to review and save it there. Eliza keeps ringing this alarm until you confirm it is saved in Clock.";
        show(new AlertDialog.Builder(activity).setTitle("Move alarm to Clock").setMessage(message)
                .setPositiveButton("Continue to Clock", (d, w) -> { dialog = null; launch(entry, zone); })
                .setNeutralButton("Remove from Eliza", (d, w) -> { dialog = null; remove(entry); })
                .setNegativeButton("Not now", (d, w) -> { dialog = null; finish("cancelled", "Not moved. Eliza keeps ringing the alarm."); })
                .setOnCancelListener(d -> { dialog = null; finish("cancelled", "Not moved. Eliza keeps ringing the alarm."); }));
    }

    private void confirm(ElizaAlarmHandoff.Entry entry) {
        String zone = ZoneId.systemDefault().getId();
        String message = "Did you save this alarm in the Clock app?\n\n" + describe(entry)
                + "\n\nCheck Clock first. Eliza keeps ringing it until you choose Saved in Clock.";
        show(new AlertDialog.Builder(activity).setTitle("Saved in Clock?").setMessage(message)
                .setPositiveButton("Saved in Clock", (d, w) -> { dialog = null; retire(entry, entry.attempt, ElizaAlarmHandoff.SAVED_IN_CLOCK); })
                .setNeutralButton("Open Clock again", (d, w) -> { dialog = null; launch(entry, zone); })
                .setNegativeButton("Not saved", (d, w) -> {
                    dialog = null; awaiting = null;
                    try {
                        ElizaAlarms.handoff(activity, (state, now) -> ElizaAlarmHandoff.release(state, entry.id, entry.attempt, "not_saved"));
                        finish("kept", "Not moved. Eliza keeps ringing the alarm.");
                    } catch (RuntimeException error) { finish("failed", "The alarm review could not be saved. Eliza keeps ringing the alarm."); }
                })
                // Asked once on return; the Clock page keeps offering the confirmation after that.
                .setOnCancelListener(d -> { dialog = null; awaiting = null; finish("cancelled", "Eliza keeps ringing the alarm until you confirm it is saved in Clock."); }));
    }

    private void remove(ElizaAlarmHandoff.Entry entry) {
        show(new AlertDialog.Builder(activity).setTitle("Remove alarm?")
                .setMessage(describe(entry) + "\n\nThis alarm stops ringing and is not saved in Clock.")
                .setPositiveButton("Remove", (d, w) -> { dialog = null; retire(entry, entry.attempt, ElizaAlarmHandoff.REMOVED); })
                .setNegativeButton("Back", (d, w) -> { dialog = null; finish("cancelled", "Not removed. Eliza keeps ringing the alarm."); })
                .setOnCancelListener(d -> { dialog = null; finish("cancelled", "Not removed. Eliza keeps ringing the alarm."); }));
    }

    private void launch(ElizaAlarmHandoff.Entry entry, String zone) {
        String attempt = UUID.randomUUID().toString();
        ClockHandoff.Result result;
        try {
            if (!foreground.getAsBoolean() || activity.isFinishing() || activity.isDestroyed())
                { finish("failed", "Open Eliza before continuing to Clock"); return; }
            KeyguardManager keyguard = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
            if (keyguard != null && keyguard.isKeyguardLocked()) { finish("failed", "Unlock the phone before continuing to Clock"); return; }
            ArrayList<Integer> days = entry.days.isEmpty() ? null : ClockDays.strict(entry.days);
            Intent target = ClockHandoff.intent("set", entry.hour, entry.minute, entry.label, null, days);
            // Journal the attempt before leaving the process; the alarm keeps ringing either way.
            ElizaAlarms.handoff(activity, (state, now) -> ElizaAlarmHandoff.offer(state, entry.id, entry.digest, attempt, now));
            result = ClockHandoff.start(activity, "set", target, zone,
                    "Clock opened. Save the alarm there, then return to Eliza to confirm. Eliza keeps ringing it until then.");
        } catch (RuntimeException error) {
            // error-policy:J1 an unreadable journal or invalid definition never launches Clock.
            finish("failed", "This alarm could not be opened in Clock. Eliza keeps ringing it."); return;
        }
        if (result.status == ClockHandoff.Status.OPENED) { awaiting = attempt; finish("opened", result.message); return; }
        awaiting = null;
        try { ElizaAlarms.handoff(activity, (state, now) -> ElizaAlarmHandoff.release(state, entry.id, attempt, result.status.wire)); }
        catch (RuntimeException error) { Log.e(TAG, "Saved alarm handoff could not be released", error); }
        finish(result.status.wire, sentence(result.message) + " Eliza keeps ringing the alarm.");
    }

    private void retire(ElizaAlarmHandoff.Entry entry, String attempt, String reason) {
        awaiting = null;
        try {
            if (!foreground.getAsBoolean()) throw new SecurityException("Alarm owner left the foreground");
            ElizaAlarms.retireForHandoff(activity, entry.id, attempt, entry.digest, reason);
        } catch (RuntimeException error) {
            // error-policy:J1 an unconfirmed retirement leaves the alarm saved and ringing.
            finish("failed", "The alarm could not be retired. Eliza keeps ringing it."); return;
        } finally {
            try { ElizaAlarmRingingService.synchronize(activity); }
            catch (RuntimeException error) { Log.e(TAG, "Ringing state could not be refreshed", error); }
        }
        finish(ElizaAlarmHandoff.SAVED_IN_CLOCK.equals(reason) ? "saved" : "removed",
                ElizaAlarmHandoff.SAVED_IN_CLOCK.equals(reason) ? "Alarm moved to Clock. Eliza no longer rings it." : "Alarm removed from Eliza.");
    }

    private void show(AlertDialog.Builder builder) {
        dialog = builder.create();
        dialog.show();
    }

    private void finish(String outcome, String message) {
        Done done = active; active = null;
        if (done != null) done.done(outcome, message);
        changed.run();
    }

    private static String sentence(String message) {
        return message.endsWith(".") ? message : message + ".";
    }

    static String describe(ElizaAlarmHandoff.Entry entry) {
        return String.format(Locale.ROOT, "%s at %02d:%02d\nRepeat: %s", entry.label.isEmpty() ? "Alarm" : entry.label,
                entry.hour, entry.minute, entry.days.isEmpty() ? "Once" : ClockDays.names(entry.days));
    }
}
