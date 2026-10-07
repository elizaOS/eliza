/**
 * Dispatches reviewed requests to an external Android Clock application.
 * The host must consume its durable approved entry and native consent before
 * entering dispatch; the return value establishes activity launch only.
 * No scheduler, alarm list, ringing state or receipt replay lives here.
 */
package ai.elizaos.app;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.AlarmClock;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

final class ClockHandoff {
    enum Action { SET, SHOW, DISMISS, SNOOZE, UPDATE, DELETE, ENABLE }

    static final class Request {
        final Action action;
        final int hour, minute, snoozeMinutes;
        final String label, timeZone;
        /** null preserves legacy omitted repeat; explicit empty means one-off. Calendar days are 1..7. */
        final List<Integer> days;
        final boolean owned;
        final String alarmId;
        final boolean enabled;

        private Request(Action action, int hour, int minute, int snoozeMinutes,
                        String label, String timeZone, List<Integer> days) {
            this(action, hour, minute, snoozeMinutes, label, timeZone, days, false, null, false);
        }

        private Request(Action action, int hour, int minute, int snoozeMinutes,
                        String label, String timeZone, List<Integer> days,
                        boolean owned, String alarmId, boolean enabled) {
            this.action = Objects.requireNonNull(action);
            this.hour = hour;
            this.minute = minute;
            this.snoozeMinutes = snoozeMinutes;
            this.label = label;
            this.timeZone = timeZone;
            this.days = days;
            this.owned = owned;
            this.alarmId = alarmId;
            this.enabled = enabled;
        }

        static Request set(int hour, int minute, String label, String timeZone) {
            return setRequest(hour, minute, label, timeZone, null);
        }

        static Request set(int hour, int minute, String label, String timeZone, List<Integer> days) {
            List<Integer> copy = Collections.unmodifiableList(new ArrayList<>(Objects.requireNonNull(days)));
            boolean[] seen = new boolean[8];
            for (int day : copy) {
                if (day < 1 || day > 7 || seen[day])
                    throw new IllegalArgumentException("Invalid Clock repeat days");
                seen[day] = true;
            }
            return setRequest(hour, minute, label, timeZone, copy);
        }

        private static Request setRequest(int hour, int minute, String label, String timeZone, List<Integer> days) {
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
                throw new IllegalArgumentException("Invalid Clock time");
            Objects.requireNonNull(label);
            if (label.length() > 200 || label.chars().anyMatch(c -> c < 32 || c == 127))
                throw new IllegalArgumentException("Invalid Clock label");
            if (timeZone == null || timeZone.length() > 100
                    || !timeZone.matches("[A-Za-z_]+(?:/[A-Za-z0-9_+.-]+)*"))
                throw new IllegalArgumentException("Invalid Clock timezone");
            ZoneId.of(timeZone);
            return new Request(Action.SET, hour, minute, 0, label, timeZone, days);
        }

        static Request snooze(int minutes) {
            if (minutes < 1 || minutes > 60)
                throw new IllegalArgumentException("Invalid Clock snooze duration");
            return new Request(Action.SNOOZE, 0, 0, minutes, null, null, null);
        }

        static Request show() { return new Request(Action.SHOW, 0, 0, 0, null, null, null); }
        static Request dismiss() { return new Request(Action.DISMISS, 0, 0, 0, null, null, null); }

        static Request owned(Request request, String alarmId, boolean enabled) {
            if (alarmId != null && !alarmId.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
                throw new IllegalArgumentException("Invalid owned alarm identifier");
            if (request.action != Action.SET && request.action != Action.SHOW && alarmId == null)
                throw new IllegalArgumentException("An owned alarm must be selected");
            if ((request.action == Action.SET || request.action == Action.UPDATE) && request.days == null)
                throw new IllegalArgumentException("Owned alarms require explicit repeat days");
            return new Request(request.action, request.hour, request.minute, request.snoozeMinutes,
                    request.label, request.timeZone, request.days, true, alarmId, enabled);
        }

        static Request update(int hour, int minute, String label, String timeZone, List<Integer> days, String alarmId) {
            Request valid = set(hour, minute, label, timeZone, days);
            return owned(new Request(Action.UPDATE, valid.hour, valid.minute, 0, valid.label, valid.timeZone, valid.days), alarmId, false);
        }

        static Request delete(String alarmId) {
            return owned(new Request(Action.DELETE, 0, 0, 0, null, null, null), alarmId, false);
        }

        static Request enable(String alarmId, boolean enabled) {
            return owned(new Request(Action.ENABLE, 0, 0, 0, null, null, null), alarmId, enabled);
        }

        void requireCurrentTimeZone(String observed) {
            if ((action == Action.SET || action == Action.UPDATE) && !timeZone.equals(observed))
                throw new IllegalStateException("Phone timezone changed; review again");
        }
    }

    interface ApprovedConsent {
        /** Atomically verify exact operation/owner/attempt and consume native consent.
         * Reject unknown or previously dispatched journal entries; never replay them. */
        void consume(Request request);
    }

    enum Outcome { OPENED, UNAVAILABLE, APPLIED }
    static final class Effect {
        final Outcome outcome;
        final String receipt;
        Effect(Outcome outcome, String receipt) { this.outcome = outcome; this.receipt = receipt; }
    }

    /** Cost: one package-manager query, one consent consume, at most one activity launch.
     * Call only on the foreground Activity thread after the native review gesture. */
    static Outcome dispatch(Activity activity, Request request, ApprovedConsent consent) {
        Objects.requireNonNull(activity);
        Objects.requireNonNull(request);
        Objects.requireNonNull(consent);
        if (request.owned) throw new SecurityException("Owned alarms cannot use an external Clock handler");
        request.requireCurrentTimeZone(ZoneId.systemDefault().getId());
        Intent intent = intentFor(request);
        PackageManager manager = activity.getPackageManager();
        if (request.action != Action.SHOW && manager.checkPermission(
                "com.android.alarm.permission.SET_ALARM", activity.getPackageName())
                != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("Android Clock SET_ALARM permission unavailable");
        List<Intent> targets = new ArrayList<>();
        for (ResolveInfo candidate : manager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)) {
            if (candidate.activityInfo == null || !candidate.activityInfo.enabled
                    || !candidate.activityInfo.exported
                    || activity.getPackageName().equals(candidate.activityInfo.packageName)) continue;
            Intent target = new Intent(intent);
            target.setComponent(new ComponentName(candidate.activityInfo.packageName, candidate.activityInfo.name));
            targets.add(target);
        }
        if (targets.isEmpty()) return Outcome.UNAVAILABLE;
        // Persist dispatch before leaving this process; launch failure must not permit replay.
        consent.consume(request);
        request.requireCurrentTimeZone(ZoneId.systemDefault().getId());
        Intent launch = targets.get(0);
        if (targets.size() > 1) {
            launch = Intent.createChooser(launch, "Choose Clock");
            launch.putExtra(Intent.EXTRA_INITIAL_INTENTS,
                    targets.subList(1, targets.size()).toArray(new Intent[0]));
        }
        activity.startActivity(launch);
        return Outcome.OPENED;
    }

    private static Intent intentFor(Request request) {
        switch (request.action) {
            case SET:
                Intent alarm = new Intent(AlarmClock.ACTION_SET_ALARM)
                        .putExtra(AlarmClock.EXTRA_HOUR, request.hour)
                        .putExtra(AlarmClock.EXTRA_MINUTES, request.minute)
                        .putExtra(AlarmClock.EXTRA_MESSAGE, request.label)
                        .putExtra(AlarmClock.EXTRA_SKIP_UI, false);
                if (request.days != null && !request.days.isEmpty())
                    alarm.putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, new ArrayList<>(request.days));
                return alarm;
            case SHOW: return new Intent(AlarmClock.ACTION_SHOW_ALARMS);
            case DISMISS: return new Intent(AlarmClock.ACTION_DISMISS_ALARM);
            case SNOOZE:
                return new Intent(AlarmClock.ACTION_SNOOZE_ALARM)
                        .putExtra(AlarmClock.EXTRA_ALARM_SNOOZE_DURATION, request.snoozeMinutes);
            default: throw new IllegalArgumentException("Unsupported Clock action");
        }
    }
}
