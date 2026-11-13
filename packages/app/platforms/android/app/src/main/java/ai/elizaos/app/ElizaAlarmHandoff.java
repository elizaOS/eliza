package ai.elizaos.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The journal that moves alarms Eliza saved under {@code clock.alarms.v1} to the phone's Clock app
 * ({@code ClockProfile.SavedAlarms.HAND_OFF_TO_CLOCK}). Pure: it edits the {@link ElizaAlarms}
 * durable state object in place and has no Android types, so it is host-tested on a plain JVM.
 *
 * <p>Each saved alarm has one entry. {@code pending}: Eliza still rings it and the owner has not
 * opened Clock for it. {@code offered}: Clock was opened with the alarm's reviewed definition, but a
 * launched Activity is not a receipt, so Eliza still rings it. Only the owner's confirmation that it
 * is saved in Clock (or an explicit removal) retires it, in the same commit that deletes its
 * definition and occurrences. A declined, failed or abandoned handoff returns it to {@code pending}
 * or leaves it {@code offered}; nothing is lost on upgrade, reboot or a cancelled handoff.
 *
 * <p>{@link #begin} is the one-time marker and is idempotent: it writes {@code startedAt} once,
 * enrolls any saved alarm without an entry, drops entries whose alarm is gone, and marks
 * {@code completedAt} once no saved alarm remains. Every other step is keyed by alarm id, the
 * attempt id written by {@link #offer} and the digest of the reviewed definition, so a repeated or
 * stale step is refused or reads back the recorded outcome instead of acting twice.
 */
final class ElizaAlarmHandoff {
    static final String KEY = "clockHandoff";
    static final int VERSION = 1;
    static final String FROM = "clock.alarms.v1";
    static final String PENDING = "pending", OFFERED = "offered";
    static final String SAVED_IN_CLOCK = "saved_in_clock", REMOVED = "removed";
    private static final List<String> LAUNCH_STATUSES = List.of("unavailable", "denied", "failed", "unknown", "not_saved");

    private ElizaAlarmHandoff() {}

    /** One saved alarm awaiting its move, with the definition the owner reviews. */
    static final class Entry {
        final String id, state, digest, attempt, label, lastStatus;
        final int hour, minute;
        final List<Integer> days;
        final boolean enabled;
        final long offeredAt;
        final int attempts;
        private Entry(JSONObject entry, JSONObject alarm) throws JSONException {
            id = entry.getString("id"); state = entry.getString("state"); digest = entry.getString("digest");
            attempt = entry.optString("attempt", ""); lastStatus = entry.optString("lastStatus", "");
            offeredAt = entry.optLong("offeredAt", 0L); attempts = entry.optInt("attempts", 0);
            hour = alarm.getInt("hour"); minute = alarm.getInt("minute"); label = alarm.getString("label");
            days = days(alarm.getJSONArray("days")); enabled = alarm.getBoolean("enabled");
        }
        boolean offered() { return OFFERED.equals(state); }
    }

    /** What retirement removed; the caller cancels these platform tokens after the commit. */
    static final class Retirement {
        final String id, reason;
        final boolean already;
        final long generation;
        final List<Long> occurrences;
        private Retirement(String id, String reason, boolean already, long generation, List<Long> occurrences) {
            this.id = id; this.reason = reason; this.already = already; this.generation = generation;
            this.occurrences = Collections.unmodifiableList(occurrences);
        }
    }

    /** Counts only; no alarm content leaves the native boundary through this. */
    static final class Summary {
        final boolean started, complete;
        final int pending, offered, saved, removed;
        Summary(boolean started, boolean complete, int pending, int offered, int saved, int removed) {
            this.started = started; this.complete = complete; this.pending = pending; this.offered = offered;
            this.saved = saved; this.removed = removed;
        }
    }

    /** Starts (once) and refreshes the journal. Returns whether {@code state} changed. */
    static boolean begin(JSONObject state, long now) throws JSONException {
        boolean changed = false;
        JSONObject journal = state.optJSONObject(KEY);
        if (journal == null) {
            journal = new JSONObject().put("version", VERSION).put("from", FROM).put("startedAt", now)
                    .put("completedAt", 0L).put("entries", new JSONArray()).put("retired", new JSONArray());
            state.put(KEY, journal);
            changed = true;
        }
        validate(journal);
        JSONArray alarms = state.getJSONArray("alarms"), entries = journal.getJSONArray("entries");
        Set<String> present = new HashSet<>();
        for (int i = 0; i < alarms.length(); i++) present.add(alarms.getJSONObject(i).getString("id"));
        for (int i = entries.length() - 1; i >= 0; i--) {
            if (!present.contains(entries.getJSONObject(i).getString("id"))) { entries.remove(i); changed = true; }
        }
        Set<String> journaled = new HashSet<>();
        for (int i = 0; i < entries.length(); i++) journaled.add(entries.getJSONObject(i).getString("id"));
        for (int i = 0; i < alarms.length(); i++) {
            JSONObject alarm = alarms.getJSONObject(i);
            String id = alarm.getString("id");
            if (journaled.contains(id)) continue;
            entries.put(new JSONObject().put("id", id).put("state", PENDING).put("digest", digest(alarm))
                    .put("attempt", "").put("offeredAt", 0L).put("attempts", 0).put("lastStatus", ""));
            changed = true;
        }
        if (entries.length() == 0 && journal.getLong("completedAt") == 0L) { journal.put("completedAt", now); changed = true; }
        else if (entries.length() > 0 && journal.getLong("completedAt") != 0L) { journal.put("completedAt", 0L); changed = true; }
        return changed;
    }

    /** The entry the owner sees next: one awaiting confirmation first, then the first pending one. */
    static Entry next(JSONObject state) throws JSONException {
        JSONObject journal = journal(state);
        if (journal == null) return null;
        JSONArray entries = journal.getJSONArray("entries");
        Entry pending = null;
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            JSONObject alarm = alarm(state, entry.getString("id"));
            if (alarm == null) continue;
            if (OFFERED.equals(entry.getString("state"))) return new Entry(entry, alarm);
            if (pending == null) pending = new Entry(entry, alarm);
        }
        return pending;
    }

    /**
     * Records that Clock is about to open for {@code id} with the reviewed definition {@code digest}.
     * Re-offering an offered entry (Clock opened again) replaces its attempt. The alarm keeps ringing.
     */
    static Entry offer(JSONObject state, String id, String digest, String attempt, long now) throws JSONException {
        requireAttempt(attempt);
        JSONObject entry = entry(state, id), alarm = alarm(state, id);
        if (entry == null || alarm == null) throw new IllegalStateException("Saved alarm is no longer waiting to move");
        if (!digest.equals(entry.getString("digest")) || !digest.equals(digest(alarm)))
            throw new IllegalStateException("Saved alarm changed; review it again");
        entry.put("state", OFFERED).put("attempt", attempt).put("offeredAt", now)
                .put("attempts", entry.optInt("attempts", 0) + 1).put("lastStatus", "");
        return new Entry(entry, alarm);
    }

    /** Clock did not open (or the owner said it is not saved): back to pending. False if stale. */
    static boolean release(JSONObject state, String id, String attempt, String status) throws JSONException {
        if (!LAUNCH_STATUSES.contains(status)) throw new IllegalArgumentException("Invalid handoff status");
        JSONObject entry = entry(state, id);
        if (entry == null || !OFFERED.equals(entry.getString("state")) || !attempt.equals(entry.getString("attempt"))) return false;
        entry.put("state", PENDING).put("attempt", "").put("lastStatus", status);
        return true;
    }

    /**
     * Retires a saved alarm: {@link #SAVED_IN_CLOCK} requires the offered attempt the owner confirmed,
     * {@link #REMOVED} any entry. Deletes its definition and occurrences in the same state edit and
     * journals the retirement. A repeated retirement of the same alarm reads back {@code already}.
     */
    static Retirement retire(JSONObject state, String id, String attempt, String digest, String reason, long now) throws JSONException {
        if (!SAVED_IN_CLOCK.equals(reason) && !REMOVED.equals(reason)) throw new IllegalArgumentException("Invalid retirement");
        JSONObject journal = journal(state);
        if (journal == null) throw new IllegalStateException("Saved alarm handoff has not started");
        JSONArray retired = journal.getJSONArray("retired");
        for (int i = 0; i < retired.length(); i++) {
            JSONObject done = retired.getJSONObject(i);
            if (id.equals(done.getString("id")) && digest.equals(done.getString("digest")) && reason.equals(done.getString("reason")))
                return new Retirement(id, reason, true, 0L, new ArrayList<>());
        }
        JSONObject entry = entry(state, id), alarm = alarm(state, id);
        if (entry == null || alarm == null) throw new IllegalStateException("Saved alarm is no longer waiting to move");
        if (!digest.equals(entry.getString("digest")) || !digest.equals(digest(alarm)))
            throw new IllegalStateException("Saved alarm changed; review it again");
        if (SAVED_IN_CLOCK.equals(reason)
                && (!OFFERED.equals(entry.getString("state")) || !entry.getString("attempt").equals(attempt)))
            throw new IllegalStateException("Open Clock for this alarm before confirming it is saved there");
        long generation = alarm.getLong("generation");
        ArrayList<Long> tokens = new ArrayList<>();
        JSONArray occurrences = state.getJSONArray("occurrences");
        for (int i = occurrences.length() - 1; i >= 0; i--) {
            JSONObject occurrence = occurrences.getJSONObject(i);
            if (id.equals(occurrence.getString("id"))) { tokens.add(occurrence.getLong("generation")); occurrences.remove(i); }
        }
        JSONArray alarms = state.getJSONArray("alarms");
        for (int i = 0; i < alarms.length(); i++) if (id.equals(alarms.getJSONObject(i).getString("id"))) { alarms.remove(i); break; }
        JSONArray entries = journal.getJSONArray("entries");
        for (int i = 0; i < entries.length(); i++) if (id.equals(entries.getJSONObject(i).getString("id"))) { entries.remove(i); break; }
        retired.put(new JSONObject().put("id", id).put("digest", digest).put("reason", reason).put("at", now));
        if (entries.length() == 0 && alarms.length() == 0) journal.put("completedAt", now);
        return new Retirement(id, reason, false, generation, tokens);
    }

    static Summary summary(JSONObject state) throws JSONException {
        JSONObject journal = journal(state);
        if (journal == null) return new Summary(false, false, 0, 0, 0, 0);
        int pending = 0, offered = 0, saved = 0, removed = 0;
        JSONArray entries = journal.getJSONArray("entries"), retired = journal.getJSONArray("retired");
        for (int i = 0; i < entries.length(); i++) {
            if (OFFERED.equals(entries.getJSONObject(i).getString("state"))) offered++; else pending++;
        }
        for (int i = 0; i < retired.length(); i++) {
            if (SAVED_IN_CLOCK.equals(retired.getJSONObject(i).getString("reason"))) saved++; else removed++;
        }
        return new Summary(true, journal.getLong("completedAt") != 0L, pending, offered, saved, removed);
    }

    /** Stable digest of the reviewed definition: time, repeat days and label. */
    static String digest(JSONObject alarm) throws JSONException {
        String value = alarm.getInt("hour") + ":" + alarm.getInt("minute") + "|" + days(alarm.getJSONArray("days")) + "|" + alarm.getString("label");
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte b : hash) out.append(String.format(java.util.Locale.ROOT, "%02x", b));
            return out.toString();
        } catch (NoSuchAlgorithmException missing) { throw new IllegalStateException("SHA-256 unavailable", missing); }
    }

    private static JSONObject journal(JSONObject state) throws JSONException {
        JSONObject journal = state.optJSONObject(KEY);
        if (journal != null) validate(journal);
        return journal;
    }

    /** Refuses a journal this build cannot read rather than guessing; the alarms keep ringing. */
    private static void validate(JSONObject journal) throws JSONException {
        if (journal.optInt("version", -1) != VERSION || !FROM.equals(journal.optString("from", ""))
                || journal.optLong("startedAt", 0L) <= 0 || journal.optLong("completedAt", -1L) < 0
                || journal.optJSONArray("entries") == null || journal.optJSONArray("retired") == null)
            throw new IllegalStateException("Unsupported saved alarm handoff journal");
        JSONArray entries = journal.getJSONArray("entries");
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            String state = entry.getString("state");
            if (!ids.add(entry.getString("id")) || !(PENDING.equals(state) || OFFERED.equals(state))
                    || !entry.getString("digest").matches("[a-f0-9]{64}")
                    || (OFFERED.equals(state) && entry.getString("attempt").isEmpty()))
                throw new IllegalStateException("Invalid saved alarm handoff entry");
        }
    }

    private static JSONObject entry(JSONObject state, String id) throws JSONException {
        JSONObject journal = journal(state);
        if (journal == null) return null;
        JSONArray entries = journal.getJSONArray("entries");
        for (int i = 0; i < entries.length(); i++) if (id.equals(entries.getJSONObject(i).getString("id"))) return entries.getJSONObject(i);
        return null;
    }

    private static JSONObject alarm(JSONObject state, String id) throws JSONException {
        JSONArray alarms = state.getJSONArray("alarms");
        for (int i = 0; i < alarms.length(); i++) if (id.equals(alarms.getJSONObject(i).getString("id"))) return alarms.getJSONObject(i);
        return null;
    }

    private static List<Integer> days(JSONArray value) throws JSONException {
        ArrayList<Integer> out = new ArrayList<>();
        for (int i = 0; i < value.length(); i++) out.add(value.getInt(i));
        Collections.sort(out);
        return Collections.unmodifiableList(out);
    }

    private static void requireAttempt(String attempt) {
        if (attempt == null || !attempt.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
            throw new IllegalArgumentException("Invalid handoff attempt");
    }
}
