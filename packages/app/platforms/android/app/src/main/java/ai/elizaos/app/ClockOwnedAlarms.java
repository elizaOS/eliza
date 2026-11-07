package ai.elizaos.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import org.json.JSONObject;

/** Native ownership, inventory and reviewed effects. No credentials or scheduling authority enters JavaScript. */
final class ClockOwnedAlarms {
    private static final String PREFS = "eliza_clock_authenticated_owner";
    private static final Object CACHE_LOCK = new Object();
    private static final java.util.Set<String> rejected = java.util.concurrent.ConcurrentHashMap.newKeySet();

    static void remember(Context context, ClockHostClient client, JSONObject authenticated) throws Exception {
        client.current();
        String owner = client.alarmOwner(authenticated);
        synchronized (CACHE_LOCK) {
            if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("fingerprint", client.localFingerprint()).putString("owner", owner).commit())
                throw new IllegalStateException("Local Clock owner could not be saved");
            rejected.remove(client.localFingerprint());
        }
        client.current();
    }

    static String owner(Context context, ClockHostClient client) throws Exception {
        client.current();
        String owner;
        synchronized (CACHE_LOCK) {
            if (rejected.contains(client.localFingerprint())) throw new SecurityException("Local Clock owner was rejected");
            SharedPreferences cache = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (!client.localFingerprint().equals(cache.getString("fingerprint", "")))
                throw new SecurityException("Connect this Clock to the current agent first");
            owner = ClockHostClient.digest(cache.getString("owner", ""));
        }
        client.current();
        return owner;
    }

    /** Known server revocation retires offline read/write authority; already scheduled alarms remain local. */
    static void revoke(Context context, ClockHostClient client) {
        String fingerprint = client.localFingerprint();
        synchronized (CACHE_LOCK) {
            rejected.add(fingerprint);
            SharedPreferences cache = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (fingerprint.equals(cache.getString("fingerprint", "")) && !cache.edit().clear().commit())
                throw new IllegalStateException("Rejected Clock owner could not be durably retired");
        }
    }

    static JSONObject metadata(Context context, ClockHostClient client) throws Exception {
        String owner = owner(context, client);
        ElizaAlarms.refreshPermissionState(context);
        JSONObject snapshot = ElizaAlarms.snapshot(context, owner);
        client.current();
        if (!owner.equals(owner(context, client))) throw new SecurityException("Clock snapshot owner changed");
        return new JSONObject().put("sensitive", false).put("revision", client.snapshot.getGeneration())
                .put("timeZone", client.timeZone).put("alarmsStatus", "available")
                .put("alarmsObservedAt", System.currentTimeMillis()).put("alarmsRevision", snapshot.getLong("revision"))
                .put("alarms", snapshot.getJSONArray("alarms"));
    }

    static JSONObject status(Context context, ClockHostClient client) throws Exception {
        String owner = owner(context, client);
        ElizaAlarms.refreshPermissionState(context);
        JSONObject snapshot = ElizaAlarms.snapshot(context, owner);
        client.current();
        if (!owner.equals(owner(context, client))) throw new SecurityException("Clock inventory owner changed");
        return permissions(context).put("available", true).put("reason", JSONObject.NULL)
                .put("owner", owner).put("alarmsRevision", snapshot.getLong("revision"))
                .put("alarmsObservedAt", System.currentTimeMillis()).put("timeZone", client.timeZone)
                .put("alarms", snapshot.getJSONArray("alarms"));
    }

    static JSONObject unavailable(Context context) throws Exception {
        return permissions(context).put("available", false).put("reason", "Connect this Clock to your agent to verify its owner.")
                .put("owner", JSONObject.NULL).put("alarmsRevision", JSONObject.NULL)
                .put("alarmsObservedAt", System.currentTimeMillis()).put("timeZone", java.time.ZoneId.systemDefault().getId())
                .put("alarms", JSONObject.NULL);
    }

    private static JSONObject permissions(Context context) throws Exception {
        ElizaAlarmRingingService.ensureNotificationChannel(context);
        return new JSONObject().put("exactAlarmsAllowed", ElizaAlarms.canSchedule(context))
                .put("notificationsAllowed", ElizaAlarmRingingService.notificationsEnabled(context))
                .put("fullScreenAllowed", ElizaAlarmRingingService.canUseFullScreen(context))
                .put("alarmSoundMuted", ElizaAlarmRingingService.alarmSoundMuted(context))
                .put("defaultToneAvailable", ElizaAlarmRingingService.defaultToneAvailable(context));
    }

    static boolean isRingingControl(ClockHandoff.Request request) {
        return request.owned && (request.action == ClockHandoff.Action.DISMISS || request.action == ClockHandoff.Action.SNOOZE);
    }

    static void requireActive(Context context, String owner, ClockHandoff.Request request, long revision) throws Exception {
        if (!isRingingControl(request)) throw new SecurityException("Only active ringing controls are immediate");
        ElizaAlarms.withRevision(context, revision, () -> {
            ElizaAlarms.find(context, request.alarmId, owner);
            ElizaAlarms.Occurrence active = ElizaAlarms.peekActive(context);
            if (active == null || !request.alarmId.equals(active.id))
                throw new SecurityException("The selected owned alarm is no longer ringing");
            return null;
        });
    }

    static ClockHandoff.Effect execute(Activity activity, String owner, ClockConsentCoordinator.Identity identity,
                          ClockHandoff.Request request, long revision, ClockHandoff.ApprovedConsent consent) throws Exception {
        if (!request.owned) throw new SecurityException("This Clock manages Eliza alarms only");
        request.requireCurrentTimeZone(java.time.ZoneId.systemDefault().getId());
        boolean[] consumed = {false};
        ClockHandoff.Effect effect;
        try {
            effect = ElizaAlarms.withRevision(activity, revision, () -> {
                ElizaAlarms.Alarm selected = request.alarmId == null ? null : ElizaAlarms.find(activity, request.alarmId, owner);
                boolean scheduling = request.action == ClockHandoff.Action.SET
                        || (request.action == ClockHandoff.Action.UPDATE && selected.enabled)
                        || (request.action == ClockHandoff.Action.ENABLE && request.enabled) || request.action == ClockHandoff.Action.SNOOZE;
                if (scheduling && (!ElizaAlarms.canSchedule(activity)
                        || !ElizaAlarmRingingService.notificationsEnabled(activity)
                        || !ElizaAlarmRingingService.defaultToneAvailable(activity)))
                    return new ClockHandoff.Effect(ClockHandoff.Outcome.UNAVAILABLE, null);
                ElizaAlarms.Occurrence current = null;
                if (request.action == ClockHandoff.Action.DISMISS || request.action == ClockHandoff.Action.SNOOZE) {
                    current = ElizaAlarms.peekActive(activity);
                    if (current == null || !request.alarmId.equals(current.id))
                        throw new SecurityException("The selected alarm is not the active ringing alarm");
                }
                consent.consume(request);
                consumed[0] = true;
                JSONObject result = new JSONObject().put("kind", "clock-alarm")
                        .put("action", request.action.name().toLowerCase(java.util.Locale.ROOT));
                ElizaAlarms.Alarm alarm;
                switch (request.action) {
                    case SET:
                        alarm = ElizaAlarms.create(activity, identity.operationId, owner, request.hour, request.minute, request.label, request.days);
                        scheduled(alarm); result.put("status", "scheduled"); break;
                    case UPDATE:
                        alarm = ElizaAlarms.update(activity, request.alarmId, owner, request.hour, request.minute, request.label, request.days);
                        if (alarm.enabled) scheduled(alarm);
                        result.put("status", "updated"); break;
                    case ENABLE:
                        alarm = ElizaAlarms.setEnabled(activity, request.alarmId, owner, request.enabled);
                        if (request.enabled) scheduled(alarm);
                        result.put("status", request.enabled ? "enabled" : "disabled"); break;
                    case DELETE:
                        if (!ElizaAlarms.delete(activity, request.alarmId, owner)) throw new IllegalStateException("Alarm deletion not committed");
                        return new ClockHandoff.Effect(ClockHandoff.Outcome.APPLIED, result.put("status", "deleted").put("alarmId", request.alarmId).toString());
                    case DISMISS:
                        if (!ElizaAlarms.dismiss(activity, current.id, current.generation)) throw new IllegalStateException("Alarm occurrence changed");
                        alarm = ElizaAlarms.find(activity, request.alarmId, owner); result.put("status", "dismissed"); break;
                    case SNOOZE:
                        if (!ElizaAlarms.snooze(activity, current.id, current.generation, request.snoozeMinutes))
                            throw new IllegalStateException("Alarm snooze was not scheduled");
                        alarm = ElizaAlarms.find(activity, request.alarmId, owner);
                        if (alarm.nextAt <= System.currentTimeMillis()) throw new IllegalStateException("Snooze receipt has no future alarm");
                        result.put("status", "snoozed"); break;
                    case SHOW:
                        activity.startActivity(new Intent(activity, MainActivity.class).setAction(Intent.ACTION_VIEW)
                                .setData(Uri.parse("elizaos://clock")).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP));
                        return new ClockHandoff.Effect(ClockHandoff.Outcome.APPLIED, result.put("status", "shown").toString());
                    default: throw new IllegalArgumentException("Unsupported owned alarm action");
                }
                return new ClockHandoff.Effect(ClockHandoff.Outcome.APPLIED, result.put("alarmId", alarm.id)
                        .put("nextAt", alarm.nextAt == 0 ? JSONObject.NULL : alarm.nextAt).toString());
            });
        } catch (Exception error) {
            if (consumed[0]) {
                try { ElizaAlarmRingingService.synchronize(activity); }
                catch (RuntimeException cleanup) { error.addSuppressed(cleanup); }
            }
            throw error;
        }
        if (consumed[0]) ElizaAlarmRingingService.synchronize(activity);
        return effect;
    }

    private static void scheduled(ElizaAlarms.Alarm alarm) {
        if (!"scheduled".equals(alarm.baseScheduleState) || alarm.nextAt <= System.currentTimeMillis())
            throw new IllegalStateException("Native alarm scheduling outcome is not confirmed");
    }
}
