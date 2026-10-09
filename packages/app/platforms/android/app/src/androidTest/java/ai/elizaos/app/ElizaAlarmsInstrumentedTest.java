package ai.elizaos.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Process;
import androidx.test.platform.app.InstrumentationRegistry;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real Android storage/platform boundary fixture. Never starts sound or changes time/settings.
 * Due-state claims use an explicit future timestamp; natural receiver delivery remains a separate test.
 * Admission requires an empty native alarm store in a disposable secondary Android user.
 */
public final class ElizaAlarmsInstrumentedTest {
    private static final String OWNER = "a".repeat(64), OTHER_OWNER = "b".repeat(64);
    private static final List<Integer> DAILY = List.of(1, 2, 3, 4, 5, 6, 7);

    private static void rejects(Runnable operation) {
        try { operation.run(); } catch (RuntimeException expected) { return; }
        fail("A changed identity, revision, or definition was admitted");
    }

    private static PendingIntent pending(Context context, String id, long generation) {
        Intent intent = new Intent(context, ElizaAlarmReceiver.class).setAction(ElizaAlarms.ACTION_FIRE)
                .setData(Uri.parse("eliza-owned-alarm://fire/" + id + "/" + generation))
                .putExtra(ElizaAlarms.EXTRA_ID, id).putExtra(ElizaAlarms.EXTRA_GENERATION, generation);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void cancelToken(Context context, String id, long generation) {
        PendingIntent intent = pending(context, id, generation);
        if (intent != null) { context.getSystemService(AlarmManager.class).cancel(intent); intent.cancel(); }
    }

    private static void cancelAllTokens(Context context, SharedPreferences prefs, String id) throws Exception {
        JSONArray alarms = new JSONObject(prefs.getString("state", "")).getJSONArray("alarms");
        for (int i = 0; i < alarms.length(); i++) {
            JSONObject alarm = alarms.getJSONObject(i);
            if (id.equals(alarm.getString("id")))
                for (long token = 1; token <= alarm.getLong("sequence"); token++) cancelToken(context, id, token);
        }
    }

    @Test public void durableReceiptsOwnerRevisionQueueAndSnoozeFences() throws Exception {
        Assume.assumeTrue("Explicit owned alarm fixture required", "1".equals(
                InstrumentationRegistry.getArguments().getString("ownedAlarmFixture")));
        assertTrue(BuildConfig.DEBUG);
        assertTrue("Disposable secondary user only", Process.myUid() / 100000 > 0);
        assertTrue("Explicit fixture run identity", InstrumentationRegistry.getArguments()
                .getString("ownedAlarmRunId", "").matches("[a-f0-9-]{36}"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences prefs = context.createDeviceProtectedStorageContext()
                .getSharedPreferences("eliza_owned_native_alarms", Context.MODE_PRIVATE);
        String baseline = prefs.getString("state", null);
        if (baseline != null) {
            JSONObject saved = new JSONObject(baseline);
            assertEquals("No preexisting definitions", 0, saved.getJSONArray("alarms").length());
            assertEquals("No preexisting occurrences", 0, saved.getJSONArray("occurrences").length());
        }
        ArrayList<String> created = new ArrayList<>();
        try {
            ZonedDateTime future = ZonedDateTime.now().plusHours(1);
            int hour = future.getHour(), minute = future.getMinute();
            long before = ElizaAlarms.revision(context);
            String first = UUID.randomUUID().toString(); created.add(first);
            ElizaAlarms.Alarm initial = ElizaAlarms.create(context, first, OWNER, hour, minute, "Native fixture first", DAILY);
            assertTrue(initial.nextAt > System.currentTimeMillis());
            assertEquals(ElizaAlarms.canSchedule(context) ? "scheduled" : "permission_required", initial.baseScheduleState);
            long committed = ElizaAlarms.revision(context);
            assertTrue(committed > before);
            assertEquals(initial.toJson().toString(), ElizaAlarms.find(context, first, OWNER).toJson().toString());
            ElizaAlarms.create(context, first, OWNER, hour, minute, "Native fixture first", DAILY);
            assertEquals("Duplicate create is readback only", committed, ElizaAlarms.revision(context));
            rejects(() -> ElizaAlarms.create(context, first, OWNER, hour, minute, "Different definition", DAILY));
            rejects(() -> ElizaAlarms.find(context, first, OTHER_OWNER));
            AtomicBoolean staleEffect = new AtomicBoolean();
            try { ElizaAlarms.withRevision(context, before, () -> { staleEffect.set(true); return null; }); fail("Stale revision accepted"); }
            catch (SecurityException expected) { assertFalse(staleEffect.get()); }
            assertEquals(committed, ElizaAlarms.revision(context));
            assertEquals(committed, ElizaAlarms.snapshot(context, OWNER).getLong("revision"));
            assertEquals(1, ElizaAlarms.list(context, OWNER).size());
            assertEquals(0, ElizaAlarms.list(context, OTHER_OWNER).size());

            if (ElizaAlarms.canSchedule(context)) {
                String second = UUID.randomUUID().toString(); created.add(second);
                ElizaAlarms.Alarm other = ElizaAlarms.create(context, second, OWNER, hour, minute, "Native fixture second", DAILY);
                assertNull("Early delivery cannot claim", ElizaAlarms.claimDue(context, first, initial.generation, initial.nextAt - 1));
                assertNotNull(ElizaAlarms.claimDue(context, first, initial.generation, initial.nextAt));
                assertNotNull(ElizaAlarms.claimDue(context, second, other.generation, other.nextAt));
                assertNull("Duplicate claim cannot ring twice", ElizaAlarms.claimDue(context, first, initial.generation, initial.nextAt));
                long queuedRevision = ElizaAlarms.revision(context);
                ElizaAlarms.Occurrence peek = ElizaAlarms.peekActive(context);
                assertEquals(first, peek.id); assertEquals(0, peek.startedAt);
                assertEquals("Read-only peek never promotes", queuedRevision, ElizaAlarms.revision(context));
                ElizaAlarms.Occurrence ringing = ElizaAlarms.active(context);
                assertTrue(ringing.startedAt > 0); assertEquals(1, ElizaAlarms.queuedCount(context));
                assertNull("Queued action cannot stop current", ElizaAlarms.peekActive(context, second, other.generation));
                assertFalse(ElizaAlarms.dismiss(context, second, other.generation));

                // A failed service-start token can be queued behind a healthy front.
                assertTrue(ElizaAlarms.retireDelivery(context, second, other.generation));
                assertFalse("Failed delivery token is not revived", ElizaAlarms.retireDelivery(context, second, other.generation));
                assertEquals(first, ElizaAlarms.peekActive(context).id);
                assertEquals(0, ElizaAlarms.queuedCount(context));
                other = ElizaAlarms.find(context, second, OWNER);
                assertEquals("audio_error", other.lastOutcome);
                assertEquals("Future recurrence survives delivery failure", "scheduled", other.baseScheduleState);
                assertTrue(other.nextAt > System.currentTimeMillis());
                assertNotNull(ElizaAlarms.claimDue(context, second, other.generation, other.nextAt));

                assertTrue(ElizaAlarms.snooze(context, first, ringing.generation, 1));
                ElizaAlarms.Alarm snoozed = ElizaAlarms.find(context, first, OWNER);
                assertEquals("snoozed", snoozed.scheduleState);
                assertNotEquals("Snooze has a new occurrence token", ringing.generation, snoozed.generation);
                assertTrue(snoozed.nextAt > System.currentTimeMillis());
                assertTrue(snoozed.nextAt < System.currentTimeMillis() + 61000L);
                assertFalse("Old notification cannot dismiss its snooze", ElizaAlarms.dismiss(context, first, ringing.generation));
                assertEquals(second, ElizaAlarms.active(context).id);
                assertNotNull(ElizaAlarms.claimDue(context, first, snoozed.generation, snoozed.nextAt));
                assertEquals(1, ElizaAlarms.queuedCount(context));
                assertTrue(ElizaAlarms.dismiss(context, second, other.generation));
                ElizaAlarms.Occurrence resumed = ElizaAlarms.active(context);
                assertEquals(first, resumed.id); assertEquals(snoozed.generation, resumed.generation);
                assertFalse(ElizaAlarms.dismiss(context, first, ringing.generation));
                assertTrue(ElizaAlarms.finish(context, first, resumed.generation, "audio_error"));
                assertEquals("audio_error", ElizaAlarms.find(context, first, OWNER).lastOutcome);
                assertNull(ElizaAlarms.peekActive(context));

                // Foreground-host denial affects every already due queue entry, never future schedules.
                ElizaAlarms.Alarm queuedFirst = ElizaAlarms.find(context, first, OWNER);
                ElizaAlarms.Alarm queuedSecond = ElizaAlarms.find(context, second, OWNER);
                assertNotNull(ElizaAlarms.claimDue(context, first, queuedFirst.generation, queuedFirst.nextAt));
                assertNotNull(ElizaAlarms.claimDue(context, second, queuedSecond.generation, queuedSecond.nextAt));
                assertEquals(2, ElizaAlarms.retireBlockedDeliveries(context));
                assertEquals(0, ElizaAlarms.retireBlockedDeliveries(context));
                assertNull("Later foreground refresh cannot revive failed starts", ElizaAlarms.active(context));
                assertEquals("audio_error", ElizaAlarms.find(context, first, OWNER).lastOutcome);
                assertEquals("audio_error", ElizaAlarms.find(context, second, OWNER).lastOutcome);
                assertEquals("scheduled", ElizaAlarms.find(context, first, OWNER).baseScheduleState);
                assertEquals("scheduled", ElizaAlarms.find(context, second, OWNER).baseScheduleState);

                ElizaAlarms.setEnabled(context, first, OWNER, false);
                assertEquals("disabled", ElizaAlarms.update(context, first, OWNER, hour, minute, "Edited while disabled", DAILY).baseScheduleState);
                assertEquals(0, ElizaAlarms.find(context, first, OWNER).nextAt);
                ElizaAlarms.setEnabled(context, first, OWNER, true);
                cancelAllTokens(context, prefs, second);
                ElizaAlarms.delete(context, second, OWNER); created.remove(second);

                // Model a persisted pre-effect/unknown record. Reconcile must not create a new PI.
                ElizaAlarms.Alarm confirmed = ElizaAlarms.find(context, first, OWNER);
                cancelToken(context, first, confirmed.generation);
                JSONObject saved = new JSONObject(prefs.getString("state", ""));
                saved.getJSONArray("alarms").getJSONObject(0).put("scheduleState", "schedule_unknown");
                assertTrue(prefs.edit().putString("state", saved.toString()).commit());
                long unknownRevision = ElizaAlarms.revision(context);
                ElizaAlarms.reconcile(context);
                assertEquals("schedule_unknown", ElizaAlarms.find(context, first, OWNER).baseScheduleState);
                assertEquals(unknownRevision, ElizaAlarms.revision(context));
                assertNull("Unknown scheduling is never replayed", pending(context, first, confirmed.generation));
                System.out.println("OWNED_ALARM_DURABILITY_QUEUE_SNOOZE_UNKNOWN_PASS");
            } else {
                assertNull(ElizaAlarms.claimDue(context, first, initial.generation, initial.nextAt));
                // Controlled persisted state models a prior confirmed schedule restored after
                // permission was lost. Android capability is real; no permission is changed here.
                JSONObject saved = new JSONObject(prefs.getString("state", ""));
                JSONObject alarm = saved.getJSONArray("alarms").getJSONObject(0);
                alarm.put("scheduleState", "scheduled").put("generation", 2L).put("sequence", 3L);
                saved.getJSONArray("occurrences")
                        .put(new JSONObject().put("id", first).put("generation", 1L).put("label", "Native fixture first")
                                .put("fireAt", System.currentTimeMillis() - 1000L).put("startedAt", 0L).put("state", "queued"))
                        .put(new JSONObject().put("id", first).put("generation", 3L).put("label", "Native fixture first")
                                .put("fireAt", System.currentTimeMillis() + 60000L).put("startedAt", 0L).put("state", "snoozed"));
                assertTrue(prefs.edit().putString("state", saved.toString()).commit());
                long permissionRevision = ElizaAlarms.revision(context);
                ElizaAlarms.refreshPermissionState(context);
                assertEquals(permissionRevision + 1, ElizaAlarms.revision(context));
                assertEquals("permission_required", ElizaAlarms.find(context, first, OWNER).baseScheduleState);
                assertEquals("permission_unavailable", ElizaAlarms.find(context, first, OWNER).lastOutcome);
                assertNull("Revoked due token cannot gain a new sound budget", ElizaAlarms.peekActive(context));
                JSONArray remaining = ElizaAlarms.snapshot(context, OWNER).getJSONArray("activeOccurrences");
                assertEquals(1, remaining.length());
                assertEquals("permission_required", remaining.getJSONObject(0).getString("state"));
                assertEquals(3L, remaining.getJSONObject(0).getLong("generation"));
                ElizaAlarms.refreshPermissionState(context);
                assertEquals("Unchanged capability read performs no commit", permissionRevision + 1, ElizaAlarms.revision(context));
                System.out.println("OWNED_ALARM_PERMISSION_GATE_PASS; exact delivery branch not exercised");
            }
        } finally {
            // Claims above use future timestamps without changing the phone clock, so cancel every
            // token created by this fixture, including consumed state tokens whose OS timer is future.
            JSONObject saved = new JSONObject(prefs.getString("state", "{\"alarms\":[]}"));
            JSONArray alarms = saved.getJSONArray("alarms");
            for (int i = 0; i < alarms.length(); i++) {
                JSONObject alarm = alarms.getJSONObject(i);
                if (!created.contains(alarm.getString("id"))) continue;
                for (long token = 1; token <= alarm.getLong("sequence"); token++) cancelToken(context, alarm.getString("id"), token);
                ElizaAlarms.delete(context, alarm.getString("id"), OWNER);
            }
            assertEquals(0, ElizaAlarms.list(context, OWNER).size());
            SharedPreferences.Editor editor = prefs.edit();
            if (baseline == null) editor.remove("state"); else editor.putString("state", baseline);
            assertTrue("Fixture native store restored", editor.commit());
        }
    }
}
