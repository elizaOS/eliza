package ai.eliza.plugins.system.clock;

import android.app.Activity;
import android.content.Intent;
import android.provider.AlarmClock;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Host JVM checks of the shared Clock handoff contract with Android stand-ins; nothing reaches a Clock app. */
public final class ClockHandoffTest {
    private static int checks;
    private static void check(boolean ok, String what) { checks++; if (!ok) throw new AssertionError(what); }
    private static void rejects(Runnable operation, String what) {
        try { operation.run(); } catch (IllegalArgumentException expected) { checks++; return; }
        throw new AssertionError("admitted: " + what);
    }
    private static JSONArray json(Object... values) { JSONArray out = new JSONArray(); for (Object v : values) out.put(v); return out; }

    public static void main(String[] args) throws Exception {
        // Strict (a host's own form): unique ascending 1..7, non-empty.
        check(ClockDays.strict(List.of(2, 3, 4, 5, 6)).equals(List.of(2, 3, 4, 5, 6)), "weekdays");
        check(ClockDays.strict((List<Integer>) null) == null && ClockDays.strict((Object) null) == null && ClockDays.strict(JSONObject.NULL) == null, "omitted");
        for (List<Integer> bad : List.<List<Integer>>of(List.of(), List.of(3, 2), List.of(2, 2), List.of(0), List.of(8), Arrays.asList(1, null)))
            rejects(() -> ClockDays.strict(bad), "strict " + bad);
        check(ClockDays.strict(json(1, 7)).equals(List.of(1, 7)), "json strict");
        rejects(() -> ClockDays.strict(json()), "strict empty json");
        rejects(() -> ClockDays.strict(json(1.5)), "fraction");
        rejects(() -> ClockDays.strict(json("2")), "string day");
        rejects(() -> ClockDays.strict("2,3"), "not an array");
        rejects(() -> ClockDays.strict(json(1, 2, 3, 4, 5, 6, 7, 1)), "more than seven");

        // Agent: any order, sorted and de-duplicated; empty is a one-time alarm.
        check(ClockDays.agent(json(7, 1, 4)).equals(List.of(1, 4, 7)), "sorted");
        check(ClockDays.agent(json(3, 2, 2)).equals(List.of(2, 3)), "de-duplicated");
        check(ClockDays.agent(json()) == null && ClockDays.agent(null) == null, "empty is one time");
        rejects(() -> ClockDays.agent(json(0)), "agent zero");

        // Explicit: caller order kept, unique, possibly empty, unmodifiable.
        check(ClockDays.explicit(List.of(7, 1, 3)).equals(List.of(7, 1, 3)), "order kept");
        check(ClockDays.explicit(List.of()).isEmpty(), "explicit one-off");
        rejects(() -> ClockDays.explicit(List.of(2, 2)), "explicit duplicate");
        rejects(() -> ClockDays.explicit(null), "explicit null");
        try { ClockDays.explicit(List.of(1)).add(2); check(false, "unmodifiable"); } catch (UnsupportedOperationException expected) { checks++; }
        check(ClockDays.names(List.of(2, 4)).equals("Mon, Wed"), "names");

        // Profiles: the handoff never reports an applied change; saved alarms stay until a decision.
        check(ClockProfile.HANDOFF_ONLY.capabilities.equals("clock.handoff.v1,clock.handoff.v2") && ClockProfile.HANDOFF_ONLY.operationType.equals("clock_handoff"), "handoff profile");
        check(ClockProfile.OWNED_ALARMS.capabilities.equals("clock.alarms.v1") && ClockProfile.OWNED_ALARMS.operationType.equals("clock_alarm"), "owned profile");
        check(!ClockProfile.HANDOFF_ONLY.reportsAppliedChanges() && ClockProfile.OWNED_ALARMS.reportsAppliedChanges(), "receipts");
        check(ClockProfile.HANDOFF_ONLY.savedAlarmsFrom(ClockProfile.OWNED_ALARMS, null) == ClockProfile.SavedAlarms.KEEP_OWNED, "undecided keeps owned");
        check(ClockProfile.HANDOFF_ONLY.savedAlarmsFrom(ClockProfile.OWNED_ALARMS, ClockProfile.SavedAlarms.READ_ONLY) == ClockProfile.SavedAlarms.READ_ONLY, "decided");
        check(ClockProfile.OWNED_ALARMS.savedAlarmsFrom(ClockProfile.OWNED_ALARMS, ClockProfile.SavedAlarms.HAND_OFF_TO_CLOCK) == ClockProfile.SavedAlarms.KEEP_OWNED, "no change, no migration");

        // Intents.
        Intent set = ClockHandoff.intent("set", 7, 30, "Wake", null, List.of(2, 3));
        check(set.action.equals(AlarmClock.ACTION_SET_ALARM) && set.extras.get(AlarmClock.EXTRA_HOUR).equals(7) && set.extras.get(AlarmClock.EXTRA_MINUTES).equals(30), "set time");
        check(Boolean.FALSE.equals(set.extras.get(AlarmClock.EXTRA_SKIP_UI)) && set.extras.get(AlarmClock.EXTRA_DAYS).equals(List.of(2, 3)), "Clock UI shown, days");
        check(!ClockHandoff.intent("set", 7, 30, "", null, null).extras.containsKey(AlarmClock.EXTRA_DAYS), "no days extra when omitted");
        check(ClockHandoff.intent("show", null, null, null, null, null).action.equals(AlarmClock.ACTION_SHOW_ALARMS), "show");
        Intent dismiss = ClockHandoff.intent("dismiss", null, null, null, null, null);
        check(dismiss.action.equals(AlarmClock.ACTION_DISMISS_ALARM) && dismiss.extras.isEmpty(), "dismiss has no target");
        check(ClockHandoff.intent("snooze", null, null, null, 10, null).extras.get(AlarmClock.EXTRA_ALARM_SNOOZE_DURATION).equals(10), "snooze");
        rejects(() -> ClockHandoff.intent("set", 24, 0, "", null, null), "hour");
        rejects(() -> ClockHandoff.intent("set", 7, 60, "", null, null), "minute");
        rejects(() -> ClockHandoff.intent("set", 7, 0, null, null, null), "label required");
        rejects(() -> ClockHandoff.intent("set", 7, 0, "x".repeat(201), null, null), "label length");
        rejects(() -> ClockHandoff.intent("set", 7, 0, "line\nbreak", null, null), "control character");
        rejects(() -> ClockHandoff.intent("set", 7, 0, "", 5, null), "snooze on set");
        rejects(() -> ClockHandoff.intent("show", null, null, null, null, List.of(2)), "days on show");
        rejects(() -> ClockHandoff.intent("dismiss", 1, null, null, null, null), "dismiss options");
        rejects(() -> ClockHandoff.intent("snooze", null, null, null, 61, null), "snooze range");
        rejects(() -> ClockHandoff.intent("delete", null, null, null, null, null), "unsupported");
        rejects(() -> ClockHandoff.intent(null, null, null, null, null, null), "no action");
        check(ClockHandoff.receiver("host.app", "host.app") == null && ClockHandoff.receiver("host.app", null) == null && "clock.app".equals(ClockHandoff.receiver("host.app", "clock.app")), "receiver");

        // Launch: reviewed, foreground, unlocked, unchanged zone, external receiver; opened is not a receipt.
        Activity activity = new Activity();
        ClockHandoff.Result r = ClockHandoff.launch(activity, "Example", "set", 7, 30, "Wake", null, false, null, null);
        check(r.status == ClockHandoff.Status.FAILED && activity.started.isEmpty(), "unreviewed");
        r = ClockHandoff.launch(activity, "Example", "set", 7, 30, "Wake", null, true, "UTC", List.of(2));
        check(r.status == ClockHandoff.Status.OPENED && "clock.app".equals(r.receiver) && r.message.contains("Example cannot confirm"), "opened");
        check(activity.started.size() == 1 && activity.started.get(0).component.packageName.equals("clock.app"), "explicit component");
        r = ClockHandoff.launch(activity, "Example", "set", 7, 30, "Wake", null, true, "Europe/Paris", null);
        check(r.status == ClockHandoff.Status.FAILED && r.message.contains("time zone"), "zone changed");
        r = ClockHandoff.launch(activity, "Example", "show", null, null, null, null, true, "UTC", null);
        check(r.status == ClockHandoff.Status.FAILED, "zone only applies to set");
        r = ClockHandoff.launch(activity, "Example", "set", 99, 0, "Wake", null, true, null, null);
        check(r.status == ClockHandoff.Status.FAILED && r.message.contains("valid alarm time"), "invalid request");
        activity.focus = false;
        r = ClockHandoff.launch(activity, "Example", "show", null, null, null, null, true, null, null);
        check(r.status == ClockHandoff.Status.FAILED && r.message.equals("Open Example before continuing to Clock"), "background host");
        activity.focus = true;
        android.app.KeyguardManager.locked = true;
        r = ClockHandoff.launch(activity, "Example", "show", null, null, null, null, true, null, null);
        check(r.status == ClockHandoff.Status.FAILED && r.message.contains("Unlock"), "locked");
        android.app.KeyguardManager.locked = false;
        activity.resolvedPackage = "host.app";
        int before = activity.started.size();
        r = ClockHandoff.launch(activity, "Example", "show", null, null, null, null, true, null, null);
        check(r.status == ClockHandoff.Status.UNAVAILABLE && activity.started.size() == before, "host never receives its own handoff");
        activity.resolvedPackage = null;
        check(ClockHandoff.launch(activity, "Example", "show", null, null, null, null, true, null, null).status == ClockHandoff.Status.UNAVAILABLE, "no Clock");
        activity.resolvedPackage = "clock.app";
        activity.failure = new SecurityException("fixture");
        check(ClockHandoff.launch(activity, "Example", "show", null, null, null, null, true, null, null).status == ClockHandoff.Status.DENIED, "denied");
        activity.failure = new android.content.ActivityNotFoundException();
        check(ClockHandoff.launch(activity, "Example", "show", null, null, null, null, true, null, null).status == ClockHandoff.Status.UNAVAILABLE, "gone");
        activity.failure = new IllegalStateException("fixture");
        check(ClockHandoff.launch(activity, "Example", "show", null, null, null, null, true, null, null).status == ClockHandoff.Status.UNKNOWN, "unknown");
        for (ClockHandoff.Status status : ClockHandoff.Status.values()) check(!status.wire.equals("applied") && !status.wire.equals("created"), "no receipt status");

        System.out.println("PASS clock handoff (" + checks + " checks)");
    }
}
