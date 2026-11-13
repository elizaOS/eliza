/**
 * Host JVM checks of the saved-alarm handoff journal (ClockProfile.SavedAlarms.HAND_OFF_TO_CLOCK)
 * against the real ElizaAlarms durable state shape. No Android, no Clock app, no platform alarm.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ElizaAlarmHandoffTest {
    private static final String OWNER = "a".repeat(64), OTHER = "b".repeat(64);
    private static final String WAKE = "11111111-1111-4111-8111-111111111111";
    private static final String GYM = "22222222-2222-4222-8222-222222222222";
    private static final String ATTEMPT = "33333333-3333-4333-8333-333333333333";
    private static final String RETRY = "44444444-4444-4444-8444-444444444444";

    private static JSONObject alarm(String id, String owner, int hour, int minute, String label, List<Integer> days, boolean enabled) throws Exception {
        return new JSONObject().put("id", id).put("owner", owner).put("hour", hour).put("minute", minute)
                .put("label", label).put("days", new JSONArray(days)).put("enabled", enabled)
                .put("generation", 4L).put("sequence", 6L).put("nextAt", enabled ? 1_900_000_000_000L : 0L)
                .put("timeZone", "UTC").put("scheduleState", enabled ? "scheduled" : "disabled");
    }

    /** A saved store as clock.alarms.v1 left it: two owners, one ringing occurrence, no journal. */
    private static JSONObject legacy() throws Exception {
        JSONObject state = new JSONObject().put("version", 1).put("revision", 41L)
                .put("alarms", new JSONArray().put(alarm(WAKE, OWNER, 7, 30, "Wake", List.of(2, 3, 4, 5, 6), true))
                        .put(alarm(GYM, OTHER, 18, 0, "", List.of(), false)))
                .put("occurrences", new JSONArray().put(new JSONObject().put("id", WAKE).put("generation", 5L)
                        .put("label", "Wake").put("fireAt", 1_800_000_000_000L).put("startedAt", 0L).put("state", "snoozed")));
        return state;
    }

    private static void refuses(ThrowingRunnable operation) {
        try { operation.run(); } catch (IllegalStateException | IllegalArgumentException expected) { return; }
        catch (Exception other) { throw new AssertionError("unexpected " + other); }
        fail("stale or changed handoff step was admitted");
    }
    private interface ThrowingRunnable { void run() throws Exception; }

    @Test
    public void beginIsAOneTimeMarkerThatEnrollsEverySavedAlarmWithoutTouchingThem() throws Exception {
        JSONObject state = legacy();
        String alarms = state.getJSONArray("alarms").toString(), occurrences = state.getJSONArray("occurrences").toString();
        assertFalse(ElizaAlarmHandoff.summary(state).started);
        assertNull(ElizaAlarmHandoff.next(state));
        assertTrue(ElizaAlarmHandoff.begin(state, 1000L));
        JSONObject journal = state.getJSONObject(ElizaAlarmHandoff.KEY);
        assertEquals(1, journal.getInt("version"));
        assertEquals("clock.alarms.v1", journal.getString("from"));
        assertEquals(1000L, journal.getLong("startedAt"));
        assertEquals(alarms, state.getJSONArray("alarms").toString());
        assertEquals(occurrences, state.getJSONArray("occurrences").toString());
        String once = state.toString();
        assertFalse("idempotent", ElizaAlarmHandoff.begin(state, 2000L));
        assertEquals(once, state.toString());
        assertEquals(1000L, journal.getLong("startedAt"));
        ElizaAlarmHandoff.Summary summary = ElizaAlarmHandoff.summary(state);
        assertTrue(summary.started); assertFalse(summary.complete);
        assertEquals(2, summary.pending); assertEquals(0, summary.offered);
        ElizaAlarmHandoff.Entry next = ElizaAlarmHandoff.next(state);
        assertEquals(WAKE, next.id); assertEquals(List.of(2, 3, 4, 5, 6), next.days);
        assertEquals(7, next.hour); assertEquals(30, next.minute); assertEquals("Wake", next.label);
        assertEquals(ElizaAlarmHandoff.PENDING, next.state);
    }

    @Test
    public void openedClockIsNotAReceiptAndOnlyConfirmationRetires() throws Exception {
        JSONObject state = legacy();
        ElizaAlarmHandoff.begin(state, 1000L);
        ElizaAlarmHandoff.Entry wake = ElizaAlarmHandoff.next(state);
        ElizaAlarmHandoff.offer(state, WAKE, wake.digest, ATTEMPT, 2000L);
        // Offered: still saved, still ringing, and shown first as awaiting confirmation.
        assertEquals(2, state.getJSONArray("alarms").length());
        assertEquals(1, state.getJSONArray("occurrences").length());
        ElizaAlarmHandoff.Entry awaiting = ElizaAlarmHandoff.next(state);
        assertTrue(awaiting.offered()); assertEquals(ATTEMPT, awaiting.attempt);
        assertEquals(1, ElizaAlarmHandoff.summary(state).offered);
        // Upgrade or reboot: begin keeps the offered entry as is.
        assertFalse(ElizaAlarmHandoff.begin(state, 3000L));
        assertTrue(ElizaAlarmHandoff.next(state).offered());
        // Confirmation must name the offered attempt and the reviewed definition.
        refuses(() -> ElizaAlarmHandoff.retire(state, WAKE, RETRY, wake.digest, ElizaAlarmHandoff.SAVED_IN_CLOCK, 4000L));
        refuses(() -> ElizaAlarmHandoff.retire(state, WAKE, ATTEMPT, "f".repeat(64), ElizaAlarmHandoff.SAVED_IN_CLOCK, 4000L));
        ElizaAlarmHandoff.Retirement retired = ElizaAlarmHandoff.retire(state, WAKE, ATTEMPT, wake.digest, ElizaAlarmHandoff.SAVED_IN_CLOCK, 4000L);
        assertFalse(retired.already);
        assertEquals(4L, retired.generation);
        assertEquals(List.of(5L), retired.occurrences);
        assertEquals(1, state.getJSONArray("alarms").length());
        assertEquals(GYM, state.getJSONArray("alarms").getJSONObject(0).getString("id"));
        assertEquals(0, state.getJSONArray("occurrences").length());
        // A repeated confirmation reads back; it never deletes anything else.
        String after = state.toString();
        assertTrue(ElizaAlarmHandoff.retire(state, WAKE, ATTEMPT, wake.digest, ElizaAlarmHandoff.SAVED_IN_CLOCK, 5000L).already);
        assertEquals(after, state.toString());
        ElizaAlarmHandoff.Summary summary = ElizaAlarmHandoff.summary(state);
        assertEquals(1, summary.saved); assertEquals(1, summary.pending); assertFalse(summary.complete);
    }

    @Test
    public void cancelledFailedOrDeclinedHandoffsKeepTheAlarm() throws Exception {
        JSONObject state = legacy();
        ElizaAlarmHandoff.begin(state, 1000L);
        ElizaAlarmHandoff.Entry wake = ElizaAlarmHandoff.next(state);
        // Pending entries cannot be confirmed without opening Clock first.
        refuses(() -> ElizaAlarmHandoff.retire(state, WAKE, "", wake.digest, ElizaAlarmHandoff.SAVED_IN_CLOCK, 2000L));
        ElizaAlarmHandoff.offer(state, WAKE, wake.digest, ATTEMPT, 2000L);
        assertFalse("stale attempt", ElizaAlarmHandoff.release(state, WAKE, RETRY, "unavailable"));
        assertTrue(ElizaAlarmHandoff.release(state, WAKE, ATTEMPT, "unavailable"));
        ElizaAlarmHandoff.Entry released = ElizaAlarmHandoff.next(state);
        assertEquals(ElizaAlarmHandoff.PENDING, released.state);
        assertEquals("unavailable", released.lastStatus);
        assertFalse("release is once", ElizaAlarmHandoff.release(state, WAKE, ATTEMPT, "unavailable"));
        refuses(() -> ElizaAlarmHandoff.retire(state, WAKE, ATTEMPT, wake.digest, ElizaAlarmHandoff.SAVED_IN_CLOCK, 3000L));
        refuses(() -> ElizaAlarmHandoff.release(state, WAKE, ATTEMPT, "opened"));
        // Opening Clock again replaces the attempt; the earlier one cannot confirm.
        ElizaAlarmHandoff.offer(state, WAKE, wake.digest, ATTEMPT, 3000L);
        ElizaAlarmHandoff.offer(state, WAKE, wake.digest, RETRY, 4000L);
        assertEquals("every opening is counted", 3, ElizaAlarmHandoff.next(state).attempts);
        refuses(() -> ElizaAlarmHandoff.retire(state, WAKE, ATTEMPT, wake.digest, ElizaAlarmHandoff.SAVED_IN_CLOCK, 5000L));
        assertTrue(ElizaAlarmHandoff.release(state, WAKE, RETRY, "not_saved"));
        assertEquals(2, state.getJSONArray("alarms").length());
        assertEquals(1, state.getJSONArray("occurrences").length());
        assertEquals(0, ElizaAlarmHandoff.summary(state).saved);
    }

    @Test
    public void aChangedOrMissingDefinitionIsNeverRetiredOrOffered() throws Exception {
        JSONObject state = legacy();
        ElizaAlarmHandoff.begin(state, 1000L);
        ElizaAlarmHandoff.Entry wake = ElizaAlarmHandoff.next(state);
        state.getJSONArray("alarms").getJSONObject(0).put("label", "Edited");
        refuses(() -> ElizaAlarmHandoff.offer(state, WAKE, wake.digest, ATTEMPT, 2000L));
        state.getJSONArray("alarms").getJSONObject(0).put("label", "Wake");
        ElizaAlarmHandoff.offer(state, WAKE, wake.digest, ATTEMPT, 2000L);
        state.getJSONArray("alarms").getJSONObject(0).put("minute", 31);
        refuses(() -> ElizaAlarmHandoff.retire(state, WAKE, ATTEMPT, wake.digest, ElizaAlarmHandoff.SAVED_IN_CLOCK, 3000L));
        assertEquals(2, state.getJSONArray("alarms").length());
        refuses(() -> ElizaAlarmHandoff.offer(state, "55555555-5555-4555-8555-555555555555", wake.digest, ATTEMPT, 3000L));
        refuses(() -> ElizaAlarmHandoff.offer(state, GYM, ElizaAlarmHandoff.next(state).digest, "not-a-uuid", 3000L));
        // An alarm deleted elsewhere leaves the journal on the next begin.
        state.getJSONArray("alarms").remove(0);
        state.getJSONArray("occurrences").remove(0);
        assertTrue(ElizaAlarmHandoff.begin(state, 4000L));
        assertEquals(1, ElizaAlarmHandoff.summary(state).pending);
        assertEquals(GYM, ElizaAlarmHandoff.next(state).id);
    }

    @Test
    public void removalNeedsNoClockAndTheMarkerCompletesWhenNothingIsLeft() throws Exception {
        JSONObject state = legacy();
        ElizaAlarmHandoff.begin(state, 1000L);
        ElizaAlarmHandoff.Entry wake = ElizaAlarmHandoff.next(state);
        ElizaAlarmHandoff.offer(state, WAKE, wake.digest, ATTEMPT, 2000L);
        ElizaAlarmHandoff.retire(state, WAKE, ATTEMPT, wake.digest, ElizaAlarmHandoff.SAVED_IN_CLOCK, 3000L);
        ElizaAlarmHandoff.Entry gym = ElizaAlarmHandoff.next(state);
        assertEquals(GYM, gym.id); assertTrue(gym.days.isEmpty()); assertFalse(gym.enabled);
        ElizaAlarmHandoff.Retirement removed = ElizaAlarmHandoff.retire(state, GYM, "", gym.digest, ElizaAlarmHandoff.REMOVED, 4000L);
        assertTrue(removed.occurrences.isEmpty());
        ElizaAlarmHandoff.Summary done = ElizaAlarmHandoff.summary(state);
        assertTrue(done.complete); assertEquals(0, done.pending + done.offered);
        assertEquals(1, done.saved); assertEquals(1, done.removed);
        assertEquals(4000L, state.getJSONObject(ElizaAlarmHandoff.KEY).getLong("completedAt"));
        assertNull(ElizaAlarmHandoff.next(state));
        assertFalse("complete stays complete", ElizaAlarmHandoff.begin(state, 5000L));
        // The retirement journal records ids, reasons and digests only, never labels.
        String retired = state.getJSONObject(ElizaAlarmHandoff.KEY).getJSONArray("retired").toString();
        assertFalse(retired.contains("Wake"));
        refuses(() -> ElizaAlarmHandoff.retire(state, GYM, "", gym.digest, "deleted", 6000L));
    }

    @Test
    public void anEmptyStoreCompletesImmediatelyAndAnUnknownJournalIsRefused() throws Exception {
        JSONObject empty = new JSONObject().put("version", 1).put("revision", 0L)
                .put("alarms", new JSONArray()).put("occurrences", new JSONArray());
        assertTrue(ElizaAlarmHandoff.begin(empty, 1000L));
        assertTrue(ElizaAlarmHandoff.summary(empty).complete);
        assertFalse(ElizaAlarmHandoff.begin(empty, 2000L));

        JSONObject future = legacy().put(ElizaAlarmHandoff.KEY, new JSONObject().put("version", 2).put("from", "clock.alarms.v1")
                .put("startedAt", 1L).put("completedAt", 0L).put("entries", new JSONArray()).put("retired", new JSONArray()));
        String before = future.toString();
        refuses(() -> ElizaAlarmHandoff.begin(future, 1000L));
        refuses(() -> ElizaAlarmHandoff.summary(future));
        assertEquals("a refused journal is left for a newer build", before, future.toString());

        JSONObject corrupt = legacy();
        ElizaAlarmHandoff.begin(corrupt, 1000L);
        corrupt.getJSONObject(ElizaAlarmHandoff.KEY).getJSONArray("entries").getJSONObject(0).put("state", "offered");
        refuses(() -> ElizaAlarmHandoff.next(corrupt));
    }

    @Test
    public void digestBindsTimeDaysAndLabel() throws Exception {
        JSONObject base = alarm(WAKE, OWNER, 7, 30, "Wake", List.of(2, 3), true);
        String digest = ElizaAlarmHandoff.digest(base);
        assertTrue(digest.matches("[a-f0-9]{64}"));
        assertEquals(digest, ElizaAlarmHandoff.digest(alarm(WAKE, OTHER, 7, 30, "Wake", List.of(3, 2), false)));
        assertNotEquals(digest, ElizaAlarmHandoff.digest(alarm(WAKE, OWNER, 7, 31, "Wake", List.of(2, 3), true)));
        assertNotEquals(digest, ElizaAlarmHandoff.digest(alarm(WAKE, OWNER, 7, 30, "Wake", List.of(2), true)));
        assertNotEquals(digest, ElizaAlarmHandoff.digest(alarm(WAKE, OWNER, 7, 30, "Gym", List.of(2, 3), true)));
        assertNotNull(ElizaAlarmHandoff.digest(alarm(WAKE, OWNER, 0, 0, "", List.of(), true)));
    }
}
