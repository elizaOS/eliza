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
import java.util.List;
import java.util.Objects;

final class ClockHandoff {
    enum Action { SET, SHOW, DISMISS, SNOOZE }

    static final class Request {
        final Action action;
        final int hour, minute, snoozeMinutes;
        final String label, timeZone;

        private Request(Action action, int hour, int minute, int snoozeMinutes,
                        String label, String timeZone) {
            this.action = Objects.requireNonNull(action);
            this.hour = hour;
            this.minute = minute;
            this.snoozeMinutes = snoozeMinutes;
            this.label = label;
            this.timeZone = timeZone;
        }

        static Request set(int hour, int minute, String label, String timeZone) {
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
                throw new IllegalArgumentException("Invalid Clock time");
            Objects.requireNonNull(label);
            if (label.length() > 200 || label.chars().anyMatch(c -> c < 32 || c == 127))
                throw new IllegalArgumentException("Invalid Clock label");
            if (timeZone == null || timeZone.length() > 100
                    || !timeZone.matches("[A-Za-z_]+(?:/[A-Za-z0-9_+.-]+)*"))
                throw new IllegalArgumentException("Invalid Clock timezone");
            ZoneId.of(timeZone);
            return new Request(Action.SET, hour, minute, 0, label, timeZone);
        }

        static Request snooze(int minutes) {
            if (minutes < 1 || minutes > 60)
                throw new IllegalArgumentException("Invalid Clock snooze duration");
            return new Request(Action.SNOOZE, 0, 0, minutes, null, null);
        }

        static Request show() { return new Request(Action.SHOW, 0, 0, 0, null, null); }
        static Request dismiss() { return new Request(Action.DISMISS, 0, 0, 0, null, null); }

        void requireCurrentTimeZone(String observed) {
            if (action == Action.SET && !timeZone.equals(observed))
                throw new IllegalStateException("Phone timezone changed; review again");
        }
    }

    interface ApprovedConsent {
        /** Atomically verify exact operation/owner/attempt and consume native consent.
         * Reject unknown or previously dispatched journal entries; never replay them. */
        void consume(Request request);
    }

    enum Outcome { OPENED, UNAVAILABLE }

    /** Cost: one package-manager query, one consent consume, at most one activity launch.
     * Call only on the foreground Activity thread after the native review gesture. */
    static Outcome dispatch(Activity activity, Request request, ApprovedConsent consent) {
        Objects.requireNonNull(activity);
        Objects.requireNonNull(request);
        Objects.requireNonNull(consent);
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
                return new Intent(AlarmClock.ACTION_SET_ALARM)
                        .putExtra(AlarmClock.EXTRA_HOUR, request.hour)
                        .putExtra(AlarmClock.EXTRA_MINUTES, request.minute)
                        .putExtra(AlarmClock.EXTRA_MESSAGE, request.label)
                        .putExtra(AlarmClock.EXTRA_SKIP_UI, false);
            case SHOW: return new Intent(AlarmClock.ACTION_SHOW_ALARMS);
            case DISMISS: return new Intent(AlarmClock.ACTION_DISMISS_ALARM);
            case SNOOZE:
                return new Intent(AlarmClock.ACTION_SNOOZE_ALARM)
                        .putExtra(AlarmClock.EXTRA_ALARM_SNOOZE_DURATION, request.snoozeMinutes);
            default: throw new IllegalArgumentException("Unsupported Clock action");
        }
    }
}
