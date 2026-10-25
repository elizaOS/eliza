package ai.elizaos.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Durable, device-local alarm definitions. No credentials, network, renderer, or model at fire time.
 * A committed schedule_unknown record precedes each platform effect. Only a successful exact schedule
 * and committed readback become scheduled. Unknown attempts are never retried by reconciliation.
 */
final class ElizaAlarms {
    static final String ACTION_FIRE = "ai.elizaos.app.ownedalarm.FIRE";
    static final String EXTRA_ID = "alarmId";
    static final String EXTRA_GENERATION = "generation";
    private static final String PREFS = "eliza_owned_native_alarms";
    private static final String KEY = "state";
    private static final long MAX_INTEGER = 9007199254740991L;
    private static final Object LOCK = new Object();
    private static volatile boolean storageFailed;

    static final class Alarm {
        final String id, owner, label, timeZone, scheduleState, baseScheduleState, lastOutcome;
        final int hour, minute;
        final List<Integer> days;
        final boolean enabled;
        final long generation, nextAt;
        private Alarm(JSONObject alarm, String state, long occurrenceGeneration, long occurrenceAt) throws JSONException {
            id = alarm.getString("id"); owner = alarm.getString("owner");
            hour = alarm.getInt("hour"); minute = alarm.getInt("minute");
            label = alarm.getString("label"); timeZone = alarm.getString("timeZone");
            days = readDays(alarm.getJSONArray("days")); enabled = alarm.getBoolean("enabled");
            generation = occurrenceGeneration == 0 ? alarm.getLong("generation") : occurrenceGeneration;
            nextAt = occurrenceAt == 0 ? alarm.getLong("nextAt") : occurrenceAt;
            scheduleState = state; baseScheduleState = alarm.getString("scheduleState");
            lastOutcome = alarm.optString("lastOutcome", "");
        }
        JSONObject toJson() {
            try {
                return new JSONObject().put("id", id).put("hour", hour).put("minute", minute)
                        .put("label", label).put("timeZone", timeZone).put("days", new JSONArray(days))
                        .put("enabled", enabled).put("generation", generation)
                        .put("nextAt", nextAt == 0 ? JSONObject.NULL : nextAt)
                        .put("scheduleState", scheduleState).put("lastOutcome", lastOutcome);
            } catch (JSONException error) { throw new IllegalStateException("Alarm receipt unavailable", error); }
        }
    }

    static final class Occurrence {
        final String id, label;
        final long generation, fireAt, startedAt;
        private Occurrence(JSONObject value) throws JSONException {
            id = value.getString("id"); generation = value.getLong("generation");
            label = value.getString("label"); fireAt = value.getLong("fireAt");
            startedAt = value.getLong("startedAt");
        }
        JSONObject toJson() {
            try {
                return new JSONObject().put("id", id).put("generation", generation).put("label", label)
                        .put("fireAt", fireAt).put("startedAt", startedAt);
            } catch (JSONException error) { throw new IllegalStateException("Alarm occurrence unavailable", error); }
        }
    }

    private static final class State {
        final JSONObject value;
        final JSONArray alarms, occurrences;
        State(JSONObject value) throws JSONException {
            this.value = value; alarms = value.getJSONArray("alarms");
            occurrences = value.getJSONArray("occurrences");
        }
    }

    static boolean canSchedule(Context context) {
        AlarmManager manager = manager(context);
        return Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms();
    }

    /** Revocation has no broadcast and Android cancels the app's future exact alarms.
     * Reflect an observed missing capability without scheduling, retrying unknown effects,
     * or letting an already due failed instance regain a fresh sound budget on a later grant.
     */
    static void refreshPermissionState(Context context) {
        synchronized (LOCK) {
            if (canSchedule(context)) return;
            State state = load(context); boolean changed = false; long now = System.currentTimeMillis();
            try {
                for (int i = 0; i < state.alarms.length(); i++) {
                    JSONObject alarm = state.alarms.getJSONObject(i);
                    String status = alarm.getString("scheduleState");
                    if (("scheduled".equals(status) || "permission_required".equals(status))
                            && alarm.getLong("nextAt") > 0 && alarm.getLong("nextAt") <= now
                            && readDays(alarm.getJSONArray("days")).isEmpty()) {
                        alarm.put("enabled", false).put("nextAt", 0L).put("scheduleState", "disabled").put("lastOutcome", "missed");
                        changed = true;
                    } else if ("scheduled".equals(status)) {
                        alarm.put("scheduleState", "permission_required"); changed = true;
                    }
                }
                for (int i = state.occurrences.length() - 1; i >= 0; i--) {
                    JSONObject occurrence = state.occurrences.getJSONObject(i);
                    String status = occurrence.getString("state");
                    if ("ringing".equals(status) || "queued".equals(status)
                            || (("snoozed".equals(status) || "permission_required".equals(status))
                                && occurrence.optLong("resumeAt", occurrence.getLong("fireAt")) <= now)) {
                        recordOutcome(state, occurrence, "permission_unavailable");
                        state.occurrences.remove(i); changed = true;
                    } else if ("snoozed".equals(status)) {
                        occurrence.put("state", "permission_required"); changed = true;
                    }
                }
                if (changed) save(context, state);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static long revision(Context context) {
        synchronized (LOCK) { return load(context).value.optLong("revision", -1); }
    }

    /** Bind the reviewed inventory and effect to one native transaction boundary. */
    static <T> T withRevision(Context context, long expected, java.util.concurrent.Callable<T> operation) throws Exception {
        synchronized (LOCK) {
            if (expected < 0 || expected > MAX_INTEGER || load(context).value.getLong("revision") != expected)
                throw new SecurityException("Native alarm inventory changed; review again");
            return operation.call();
        }
    }

    static JSONObject snapshot(Context context, String owner) {
        requireOwner(owner);
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONArray alarms = new JSONArray(), occurrences = new JSONArray();
                for (int i = 0; i < state.alarms.length(); i++) {
                    JSONObject value = state.alarms.getJSONObject(i);
                    if (owner.equals(value.getString("owner"))) alarms.put(receipt(state, value).toJson());
                }
                for (int i = 0; i < state.occurrences.length(); i++) {
                    JSONObject value = state.occurrences.getJSONObject(i);
                    JSONObject alarm = find(state, value.getString("id"));
                    if (alarm != null && owner.equals(alarm.getString("owner")))
                        occurrences.put(new Occurrence(value).toJson().put("state", value.getString("state")));
                }
                return new JSONObject().put("revision", state.value.getLong("revision"))
                        .put("alarms", alarms).put("activeOccurrences", occurrences);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static List<Alarm> list(Context context, String owner) {
        requireOwner(owner);
        synchronized (LOCK) {
            State state = load(context); ArrayList<Alarm> result = new ArrayList<>();
            try {
                for (int i = 0; i < state.alarms.length(); i++) {
                    JSONObject alarm = state.alarms.getJSONObject(i);
                    if (owner.equals(alarm.getString("owner"))) result.add(receipt(state, alarm));
                }
                return Collections.unmodifiableList(result);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static Alarm find(Context context, String id, String owner) {
        requireId(id); requireOwner(owner);
        synchronized (LOCK) {
            State state = load(context);
            try { return receipt(state, owned(state, id, owner)); }
            catch (JSONException error) { throw invalid(error); }
        }
    }

    static Alarm create(Context context, String id, String owner, int hour, int minute,
                        String label, List<Integer> days) {
        requireId(id); requireOwner(owner); ElizaAlarmSchedule.validate(hour, minute, label);
        List<Integer> repeat = ElizaAlarmSchedule.days(days);
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject existing = find(state, id);
                if (existing != null) {
                    if (!owner.equals(existing.getString("owner")) || existing.getInt("hour") != hour
                            || existing.getInt("minute") != minute || !label.equals(existing.getString("label"))
                            || !repeat.equals(readDays(existing.getJSONArray("days"))))
                        throw new SecurityException("Alarm identity already has a different definition");
                    // Idempotency reads the receipt; it never repeats an unknown scheduling attempt.
                    return receipt(state, existing);
                }
                JSONObject alarm = new JSONObject().put("id", id).put("owner", owner)
                        .put("hour", hour).put("minute", minute).put("label", label)
                        .put("days", new JSONArray(repeat)).put("enabled", true)
                        .put("generation", 1L).put("sequence", 1L).put("nextAt", 0L)
                        .put("timeZone", ZoneId.systemDefault().getId()).put("scheduleState", "schedule_unknown");
                state.alarms.put(alarm);
                prepare(context, state, alarm, System.currentTimeMillis());
                install(context, state, alarm);
                return receipt(state, alarm);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static Alarm update(Context context, String id, String owner, int hour, int minute,
                        String label, List<Integer> days) {
        requireId(id); requireOwner(owner); ElizaAlarmSchedule.validate(hour, minute, label);
        List<Integer> repeat = ElizaAlarmSchedule.days(days);
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject alarm = owned(state, id, owner);
                long previous = alarm.getLong("generation");
                List<Long> occurrences = removeOccurrences(state, id);
                alarm.put("hour", hour).put("minute", minute).put("label", label).put("days", new JSONArray(repeat));
                alarm.put("generation", allocate(alarm));
                if (alarm.getBoolean("enabled")) {
                    prepare(context, state, alarm, System.currentTimeMillis());
                    cancel(context, id, previous); cancelOccurrences(context, id, occurrences);
                    install(context, state, alarm);
                } else {
                    alarm.put("nextAt", 0L).put("scheduleState", "disabled"); save(context, state);
                    cancel(context, id, previous); cancelOccurrences(context, id, occurrences);
                }
                return receipt(state, alarm);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static Alarm setEnabled(Context context, String id, String owner, boolean enabled) {
        requireId(id); requireOwner(owner);
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject alarm = owned(state, id, owner);
                if (alarm.getBoolean("enabled") == enabled
                        && (enabled ? "scheduled".equals(alarm.getString("scheduleState"))
                                    : "disabled".equals(alarm.getString("scheduleState")))
                        && (enabled || !hasOccurrences(state, id))) return receipt(state, alarm);
                long previous = alarm.getLong("generation");
                List<Long> occurrences = removeOccurrences(state, id);
                alarm.put("enabled", enabled).put("generation", allocate(alarm));
                if (enabled) {
                    prepare(context, state, alarm, System.currentTimeMillis());
                    cancel(context, id, previous); cancelOccurrences(context, id, occurrences); install(context, state, alarm);
                } else {
                    alarm.put("nextAt", 0L).put("scheduleState", "disabled"); save(context, state);
                    cancel(context, id, previous); cancelOccurrences(context, id, occurrences);
                }
                return receipt(state, alarm);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static boolean delete(Context context, String id, String owner) {
        requireId(id); requireOwner(owner);
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject alarm = owned(state, id, owner);
                long previous = alarm.getLong("generation");
                List<Long> occurrences = removeOccurrences(state, id);
                for (int i = 0; i < state.alarms.length(); i++)
                    if (id.equals(state.alarms.getJSONObject(i).getString("id"))) { state.alarms.remove(i); break; }
                save(context, state);
                cancel(context, id, previous); cancelOccurrences(context, id, occurrences); return true;
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    /** Receiver-only claim. The internal PendingIntent must match a durable future occurrence token. */
    static Occurrence claimDue(Context context, String id, long generation, long now) {
        requireId(id); requireGeneration(generation);
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject alarm = find(state, id);
                if (alarm == null) return null;
                JSONObject snoozed = occurrence(state, id, generation);
                if (snoozed != null) {
                    long dueAt = snoozed.optLong("resumeAt", snoozed.getLong("fireAt"));
                    if (!"snoozed".equals(snoozed.getString("state")) || dueAt > now) return null;
                    snoozed.put("state", "queued").put("startedAt", snoozed.optLong("resumeStartedAt", 0L));
                    snoozed.remove("resumeAt"); snoozed.remove("resumeStartedAt"); save(context, state);
                    return new Occurrence(snoozed);
                }
                if (!alarm.getBoolean("enabled") || alarm.getLong("generation") != generation
                        || !"scheduled".equals(alarm.getString("scheduleState"))
                        || alarm.getLong("nextAt") == 0 || alarm.getLong("nextAt") > now) return null;
                JSONObject due = new JSONObject().put("id", id).put("generation", generation)
                        .put("label", alarm.getString("label")).put("fireAt", alarm.getLong("nextAt"))
                        .put("startedAt", 0L).put("state", "queued");
                state.occurrences.put(due);
                List<Integer> days = readDays(alarm.getJSONArray("days"));
                alarm.put("generation", allocate(alarm));
                if (days.isEmpty()) {
                    alarm.put("enabled", false).put("nextAt", 0L).put("scheduleState", "disabled"); save(context, state);
                } else {
                    prepare(context, state, alarm, now);
                    // A failed next schedule must not discard this already due audible occurrence.
                    try { install(context, state, alarm); }
                    catch (IllegalStateException error) {
                        if (storageFailed) throw error;
                        android.util.Log.e("ElizaAlarms", "Next recurrence scheduling failed", error);
                    }
                }
                return new Occurrence(due);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    /** Promotes the first queued instance; queued instances receive no ringing timeout yet. */
    static Occurrence active(Context context) {
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject current = front(state);
                if (current == null) return null;
                if ("queued".equals(current.getString("state"))) {
                    current.put("state", "ringing");
                    if (current.getLong("startedAt") == 0) current.put("startedAt", System.currentTimeMillis());
                    save(context, state);
                }
                return new Occurrence(current);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    /** Inventory and consent checks must never start an occurrence or mutate its revision. */
    static Occurrence peekActive(Context context) {
        synchronized (LOCK) {
            try {
                JSONObject current = front(load(context));
                return current == null ? null : new Occurrence(current);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static Occurrence peekActive(Context context, String id, long generation) {
        requireId(id); requireGeneration(generation);
        synchronized (LOCK) {
            Occurrence current = peekActive(context);
            return current != null && id.equals(current.id) && generation == current.generation ? current : null;
        }
    }

    static Occurrence active(Context context, String id, long generation) {
        requireId(id); requireGeneration(generation);
        synchronized (LOCK) {
            Occurrence current = active(context);
            return current != null && id.equals(current.id) && generation == current.generation ? current : null;
        }
    }

    static int queuedCount(Context context) {
        synchronized (LOCK) {
            State state = load(context); int count = 0;
            try {
                for (int i = 0; i < state.occurrences.length(); i++) {
                    String status = state.occurrences.getJSONObject(i).getString("state");
                    if ("queued".equals(status) || "ringing".equals(status)) count++;
                }
                return Math.max(0, count - 1);
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static boolean dismiss(Context context, String id, long generation) { return finish(context, id, generation, "dismissed"); }

    /** Internal delivery failure may affect a queued token, but never a future or snoozed instance. */
    static boolean retireDelivery(Context context, String id, long generation) {
        requireId(id); requireGeneration(generation);
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject failed = occurrence(state, id, generation);
                if (failed == null || !("queued".equals(failed.getString("state")) || "ringing".equals(failed.getString("state")))) return false;
                recordOutcome(state, failed, "audio_error"); removeOccurrence(state, failed); save(context, state); return true;
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    /** Without a foreground playback host these already due instances cannot sound.
     * Retire their delivery state atomically; future recurring and snoozed schedules remain exact.
     */
    static int retireBlockedDeliveries(Context context) {
        synchronized (LOCK) {
            State state = load(context); int count = 0;
            try {
                for (int i = state.occurrences.length() - 1; i >= 0; i--) {
                    JSONObject failed = state.occurrences.getJSONObject(i);
                    String status = failed.getString("state");
                    if (!("queued".equals(status) || "ringing".equals(status))) continue;
                    recordOutcome(state, failed, "audio_error"); state.occurrences.remove(i); count++;
                }
                if (count > 0) save(context, state);
                return count;
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    private static void recordOutcome(State state, JSONObject failed, String outcome) throws JSONException {
        JSONObject alarm = find(state, failed.getString("id"));
        if (alarm == null) throw new IllegalStateException("Alarm definition missing");
        alarm.put("lastOutcome", outcome).put("lastOccurrence", new Occurrence(failed).toJson());
    }

    static boolean finish(Context context, String id, long generation, String outcome) {
        requireId(id); requireGeneration(generation);
        if (!java.util.Arrays.asList("dismissed", "timed_out", "audio_error", "audio_focus_denied", "interrupted").contains(outcome))
            throw new IllegalArgumentException("Invalid ringing outcome");
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject current = front(state);
                if (!matches(current, id, generation)) return false;
                JSONObject alarm = find(state, id);
                if (alarm != null) alarm.put("lastOutcome", outcome).put("lastOccurrence", new Occurrence(current).toJson());
                removeOccurrence(state, current); save(context, state); return true;
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    static boolean snooze(Context context, String id, long generation, int minutes) {
        requireId(id); requireGeneration(generation);
        if (minutes < 1 || minutes > 60) throw new IllegalArgumentException("Invalid snooze duration");
        synchronized (LOCK) {
            State state = load(context);
            try {
                JSONObject current = front(state);
                if (!matches(current, id, generation)) return false;
                JSONObject alarm = find(state, id);
                if (alarm == null) throw new IllegalStateException("Alarm definition missing");
                long token = allocate(alarm);
                current.put("generation", token).put("fireAt", System.currentTimeMillis() + minutes * 60000L)
                        .put("startedAt", 0L).put("state", "schedule_unknown");
                current.remove("resumeAt"); current.remove("resumeStartedAt");
                save(context, state);
                if (!canSchedule(context)) {
                    current.put("state", "permission_required"); save(context, state); return false;
                }
                try {
                    schedule(context, id, token, current.getLong("fireAt"));
                    current.put("state", "snoozed"); save(context, state); return true;
                } catch (RuntimeException error) {
                    cancel(context, id, token);
                    if (!storageFailed) { current.put("state", "schedule_unknown"); save(context, state); }
                    throw new IllegalStateException("Snooze scheduling outcome unavailable", error);
                }
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    /** Restore only confirmed schedules and known missing-permission definitions, never unknown attempts. */
    static void reconcile(Context context) { reconcile(context, false); }

    /** Boot cannot start a media-playback service at target 35+. Resume sound through a new exact alarm. */
    static void reconcile(Context context, boolean resumeActive) {
        synchronized (LOCK) {
            State state = load(context); long now = System.currentTimeMillis();
            IllegalStateException failure = null;
            try {
                for (int i = 0; i < state.alarms.length(); i++) {
                    try {
                        JSONObject alarm = state.alarms.getJSONObject(i);
                        String status = alarm.getString("scheduleState");
                        if (!alarm.getBoolean("enabled") || !("scheduled".equals(status) || "permission_required".equals(status))) continue;
                        long saved = alarm.getLong("nextAt");
                        List<Integer> days = readDays(alarm.getJSONArray("days"));
                        if (saved <= now && days.isEmpty()) {
                            long previous = alarm.getLong("generation");
                            alarm.put("enabled", false).put("nextAt", 0L).put("scheduleState", "disabled")
                                    .put("lastOutcome", "missed"); save(context, state);
                            cancel(context, alarm.getString("id"), previous); continue;
                        }
                        String zone = ZoneId.systemDefault().getId();
                        long next = ElizaAlarmSchedule.next(now, alarm.getInt("hour"), alarm.getInt("minute"), days, ZoneId.of(zone));
                        long previous = alarm.getLong("generation");
                        if (next != saved || !zone.equals(alarm.getString("timeZone"))) alarm.put("generation", allocate(alarm));
                        prepare(context, state, alarm, now);
                        if (previous != alarm.getLong("generation")) cancel(context, alarm.getString("id"), previous);
                        install(context, state, alarm);
                    } catch (RuntimeException error) {
                        if (storageFailed) throw error;
                        if (failure == null) failure = new IllegalStateException("Some native alarms could not be restored");
                        failure.addSuppressed(error);
                    }
                }
                for (int i = 0; i < state.occurrences.length(); i++) {
                    try {
                        JSONObject occurrence = state.occurrences.getJSONObject(i);
                        String status = occurrence.getString("state");
                        boolean sounding = "ringing".equals(status) || "queued".equals(status);
                        if (!("snoozed".equals(status) || "permission_required".equals(status) || (resumeActive && sounding))) continue;
                        long dueAt = occurrence.optLong("resumeAt", occurrence.getLong("fireAt"));
                        if ("permission_required".equals(status) && dueAt <= now) {
                            // A canceled snooze that elapsed without permission is a failure,
                            // not a newly authorized immediate alarm when permission returns.
                            recordOutcome(state, occurrence, "permission_unavailable");
                            state.occurrences.remove(i--); save(context, state); continue;
                        }
                        if (sounding || dueAt <= now) {
                            JSONObject alarm = find(state, occurrence.getString("id"));
                            if (alarm == null) throw new IllegalStateException("Alarm definition missing");
                            long original = occurrence.getLong("generation");
                            occurrence.put("generation", allocate(alarm)).put("resumeAt", now + 1000L)
                                    .put("resumeStartedAt", sounding ? occurrence.getLong("startedAt") : occurrence.optLong("resumeStartedAt", 0L));
                            dueAt = now + 1000L;
                            occurrence.put("state", "schedule_unknown"); save(context, state);
                            cancel(context, occurrence.getString("id"), original);
                        } else {
                            occurrence.put("state", "schedule_unknown"); save(context, state);
                        }
                        if (!canSchedule(context)) { occurrence.put("state", "permission_required"); save(context, state); continue; }
                        String id = occurrence.getString("id"); long token = occurrence.getLong("generation");
                        try {
                            schedule(context, id, token, dueAt);
                            occurrence.put("state", "snoozed"); save(context, state);
                        } catch (RuntimeException error) {
                            cancel(context, id, token);
                            if (!storageFailed) { occurrence.put("state", "schedule_unknown"); save(context, state); }
                            throw new IllegalStateException("Snooze restoration outcome unavailable", error);
                        }
                    } catch (RuntimeException error) {
                        if (storageFailed) throw error;
                        if (failure == null) failure = new IllegalStateException("Some native alarms could not be restored");
                        failure.addSuppressed(error);
                    }
                }
                if (failure != null) throw failure;
            } catch (JSONException error) { throw invalid(error); }
        }
    }

    private static void prepare(Context context, State state, JSONObject alarm, long now) throws JSONException {
        String zone = ZoneId.systemDefault().getId();
        long next = ElizaAlarmSchedule.next(now, alarm.getInt("hour"), alarm.getInt("minute"), readDays(alarm.getJSONArray("days")), ZoneId.of(zone));
        alarm.put("timeZone", zone).put("nextAt", next).put("scheduleState", "schedule_unknown"); save(context, state);
    }

    private static void install(Context context, State state, JSONObject alarm) throws JSONException {
        if (!canSchedule(context)) { alarm.put("scheduleState", "permission_required"); save(context, state); return; }
        String id = alarm.getString("id"); long token = alarm.getLong("generation");
        try {
            schedule(context, id, token, alarm.getLong("nextAt"));
            alarm.put("scheduleState", "scheduled"); save(context, state);
        } catch (RuntimeException error) {
            cancel(context, id, token);
            if (!storageFailed) { alarm.put("scheduleState", "schedule_unknown"); save(context, state); }
            throw new IllegalStateException("Alarm scheduling outcome unavailable", error);
        }
    }

    private static void schedule(Context context, String id, long token, long at) {
        PendingIntent operation = pending(context, id, token, false);
        Intent show = new Intent(context, ElizaClockActivity.class).setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse("eliza-owned-alarm://show/" + id));
        PendingIntent display = PendingIntent.getActivity(context, 0, show, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        manager(context).setAlarmClock(new AlarmManager.AlarmClockInfo(at, display), operation);
    }

    private static PendingIntent pending(Context context, String id, long token, boolean existing) {
        Intent intent = new Intent(context, ElizaAlarmReceiver.class).setAction(ACTION_FIRE)
                .setData(Uri.parse("eliza-owned-alarm://fire/" + id + "/" + token))
                .putExtra(EXTRA_ID, id).putExtra(EXTRA_GENERATION, token);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE
                | (existing ? PendingIntent.FLAG_NO_CREATE : PendingIntent.FLAG_UPDATE_CURRENT));
    }

    private static void cancel(Context context, String id, long token) {
        PendingIntent operation = pending(context, id, token, true);
        if (operation != null) { manager(context).cancel(operation); operation.cancel(); }
    }

    private static List<Long> removeOccurrences(State state, String id) throws JSONException {
        ArrayList<Long> tokens = new ArrayList<>();
        for (int i = state.occurrences.length() - 1; i >= 0; i--) {
            JSONObject value = state.occurrences.getJSONObject(i);
            if (id.equals(value.getString("id"))) { tokens.add(value.getLong("generation")); state.occurrences.remove(i); }
        }
        return tokens;
    }

    private static void cancelOccurrences(Context context, String id, List<Long> tokens) {
        for (long token : tokens) cancel(context, id, token);
    }

    private static Alarm receipt(State state, JSONObject alarm) throws JSONException {
        String presentation = alarm.getString("scheduleState");
        long generation = 0L, nextAt = 0L;
        for (int i = 0; i < state.occurrences.length(); i++) {
            JSONObject value = state.occurrences.getJSONObject(i);
            if (!alarm.getString("id").equals(value.getString("id"))) continue;
            String status = value.getString("state");
            if ("ringing".equals(status) || "queued".equals(status)) {
                presentation = "firing"; generation = value.getLong("generation"); nextAt = 0L; break;
            }
            if ("snoozed".equals(status)) {
                presentation = "snoozed"; generation = value.getLong("generation");
                nextAt = value.optLong("resumeAt", value.getLong("fireAt"));
            } else if ("permission_required".equals(status) || "schedule_unknown".equals(status)) {
                presentation = status; generation = value.getLong("generation");
                nextAt = value.optLong("resumeAt", value.getLong("fireAt"));
            }
        }
        return new Alarm(alarm, presentation, generation, nextAt);
    }

    private static boolean hasOccurrences(State state, String id) throws JSONException {
        for (int i = 0; i < state.occurrences.length(); i++)
            if (id.equals(state.occurrences.getJSONObject(i).getString("id"))) return true;
        return false;
    }

    private static JSONObject find(State state, String id) throws JSONException {
        for (int i = 0; i < state.alarms.length(); i++) {
            JSONObject value = state.alarms.getJSONObject(i);
            if (id.equals(value.getString("id"))) return value;
        }
        return null;
    }

    private static JSONObject owned(State state, String id, String owner) throws JSONException {
        JSONObject value = find(state, id);
        if (value == null || !owner.equals(value.getString("owner"))) throw new SecurityException("Alarm owner or identity changed");
        return value;
    }

    private static JSONObject occurrence(State state, String id, long generation) throws JSONException {
        for (int i = 0; i < state.occurrences.length(); i++) {
            JSONObject value = state.occurrences.getJSONObject(i);
            if (matches(value, id, generation)) return value;
        }
        return null;
    }

    private static JSONObject front(State state) throws JSONException {
        for (int i = 0; i < state.occurrences.length(); i++) {
            JSONObject value = state.occurrences.getJSONObject(i);
            String status = value.getString("state");
            if ("queued".equals(status) || "ringing".equals(status)) return value;
        }
        return null;
    }

    private static boolean matches(JSONObject value, String id, long generation) throws JSONException {
        return value != null && id.equals(value.getString("id")) && generation == value.getLong("generation");
    }

    private static void removeOccurrence(State state, JSONObject current) throws JSONException {
        for (int i = 0; i < state.occurrences.length(); i++) {
            JSONObject value = state.occurrences.getJSONObject(i);
            if (matches(value, current.getString("id"), current.getLong("generation"))) { state.occurrences.remove(i); return; }
        }
    }

    private static long allocate(JSONObject alarm) throws JSONException {
        long next = alarm.getLong("sequence") + 1; requireGeneration(next); alarm.put("sequence", next); return next;
    }

    private static List<Integer> readDays(JSONArray value) throws JSONException {
        ArrayList<Integer> result = new ArrayList<>();
        for (int i = 0; i < value.length(); i++) result.add(value.getInt(i));
        return ElizaAlarmSchedule.days(result);
    }

    private static SharedPreferences prefs(Context context) {
        return context.createDeviceProtectedStorageContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static State load(Context context) {
        if (storageFailed) throw new IllegalStateException("Alarm durable storage failed; outcome unavailable");
        try {
            String saved = prefs(context).getString(KEY, null);
            JSONObject value = saved == null ? new JSONObject().put("version", 1).put("revision", 0L)
                    .put("alarms", new JSONArray()).put("occurrences", new JSONArray()) : new JSONObject(saved);
            if (value.getInt("version") != 1 || value.getLong("revision") < 0 || value.getLong("revision") > MAX_INTEGER)
                throw new IllegalStateException("Unsupported alarm durable storage");
            State state = new State(value); java.util.HashSet<String> ids = new java.util.HashSet<>();
            for (int i = 0; i < state.alarms.length(); i++) {
                JSONObject alarm = state.alarms.getJSONObject(i);
                String id = alarm.getString("id"); requireId(id); requireOwner(alarm.getString("owner"));
                if (!ids.add(id)) throw new IllegalStateException("Duplicate alarm identity");
                ElizaAlarmSchedule.validate(alarm.getInt("hour"), alarm.getInt("minute"), alarm.getString("label"));
                readDays(alarm.getJSONArray("days")); requireGeneration(alarm.getLong("generation"));
                requireGeneration(alarm.getLong("sequence")); ZoneId.of(alarm.getString("timeZone"));
                if (alarm.getLong("sequence") < alarm.getLong("generation")) throw new IllegalStateException("Invalid alarm sequence");
                if (!java.util.Arrays.asList("scheduled", "disabled", "permission_required", "schedule_unknown").contains(alarm.getString("scheduleState")))
                    throw new IllegalStateException("Invalid durable alarm status");
                if (alarm.getLong("nextAt") < 0) throw new IllegalStateException("Invalid alarm date");
            }
            java.util.HashSet<String> tokens = new java.util.HashSet<>();
            for (int i = 0; i < state.occurrences.length(); i++) {
                JSONObject occurrence = state.occurrences.getJSONObject(i);
                String id = occurrence.getString("id"); requireId(id); long generation = occurrence.getLong("generation");
                requireGeneration(generation);
                if (!ids.contains(id) || !tokens.add(id + ":" + generation)) throw new IllegalStateException("Invalid occurrence identity");
                if (generation > find(state, id).getLong("sequence")) throw new IllegalStateException("Invalid occurrence sequence");
                ElizaAlarmSchedule.validate(0, 0, occurrence.getString("label"));
                if (occurrence.getLong("fireAt") <= 0 || occurrence.getLong("startedAt") < 0
                        || !java.util.Arrays.asList("queued", "ringing", "snoozed", "permission_required", "schedule_unknown").contains(occurrence.getString("state")))
                    throw new IllegalStateException("Invalid occurrence status");
            }
            return state;
        } catch (JSONException | IllegalArgumentException error) { throw invalid(error); }
    }

    private static void save(Context context, State state) throws JSONException {
        if (storageFailed) throw new IllegalStateException("Alarm durable storage failed; outcome unavailable");
        long revision = state.value.getLong("revision") + 1;
        if (revision > MAX_INTEGER) throw new IllegalStateException("Alarm revision exhausted");
        state.value.put("revision", revision); String encoded = state.value.toString();
        SharedPreferences prefs = prefs(context);
        if (!prefs.edit().putString(KEY, encoded).commit() || !encoded.equals(prefs.getString(KEY, null))) {
            storageFailed = true;
            throw new IllegalStateException("Alarm durable commit failed; outcome unavailable");
        }
    }

    private static AlarmManager manager(Context context) {
        AlarmManager result = context.getSystemService(AlarmManager.class);
        if (result == null) throw new IllegalStateException("Android alarm service unavailable");
        return result;
    }

    private static void requireId(String id) {
        if (id == null || !UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("Invalid alarm identity");
    }
    private static void requireOwner(String owner) {
        if (owner == null || !owner.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid alarm owner");
    }
    private static void requireGeneration(long generation) {
        if (generation < 1 || generation > MAX_INTEGER) throw new IllegalArgumentException("Invalid occurrence generation");
    }
    private static IllegalStateException invalid(Exception error) { return new IllegalStateException("Alarm durable state unavailable", error); }
}
