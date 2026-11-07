package ai.eliza.plugins.system.clock;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.provider.AlarmClock;
import java.util.ArrayList;
import java.util.List;

/**
 * Standard Android Clock intents for a reviewed handoff, shared by elizaOS hosts. A launched
 * Activity is not an alarm mutation receipt: the strongest outcome is {@link Status#OPENED}, which
 * means only that the Clock app received the request.
 *
 * <p>Requests never use "all alarms", inferred labels or a deep link to select an alarm: dismiss and
 * snooze carry no target, and {@code EXTRA_SKIP_UI} is always false so Clock shows its own review.
 * The receiving activity is resolved and bound explicitly, and the host itself never receives the
 * request (a HOME-role launcher or a host-owned Clock would otherwise loop).
 */
public final class ClockHandoff {
    private ClockHandoff() {}

    public enum Status {
        OPENED("opened"), UNAVAILABLE("unavailable"), DENIED("denied"), FAILED("failed"), UNKNOWN("unknown");
        public final String wire;
        Status(String wire) { this.wire = wire; }
    }

    /** A launch outcome with a user-facing message; {@code receiver} is set only when opened. */
    public static final class Result {
        public final String action;
        public final Status status;
        public final String message;
        public final String receiver;
        Result(String action, Status status, String message, String receiver) {
            this.action = action; this.status = status; this.message = message; this.receiver = receiver;
        }
    }

    public static Result result(String action, Status status, String message) {
        return new Result(action, status, message, null);
    }

    /** Builds the intent for {@code set}, {@code show}, {@code dismiss} or {@code snooze}; refuses anything else. */
    public static Intent intent(String action, Integer hour, Integer minute, String label, Integer snoozeMinutes, List<Integer> repeatDays) {
        if (action == null) throw new IllegalArgumentException("Choose a Clock action");
        ArrayList<Integer> days = repeatDays == null ? null : ClockDays.strict(repeatDays);
        if (days != null && !"set".equals(action)) throw new IllegalArgumentException("Repeat days apply only to a new alarm");
        switch (action) {
            case "set": {
                if (hour == null || minute == null || hour < 0 || hour > 23 || minute < 0 || minute > 59 || snoozeMinutes != null)
                    throw new IllegalArgumentException("Choose a valid alarm time");
                if (label == null || label.length() > 200 || label.chars().anyMatch(c -> c < 32 || c == 127))
                    throw new IllegalArgumentException("Use an alarm label up to 200 characters");
                Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
                        .putExtra(AlarmClock.EXTRA_HOUR, hour)
                        .putExtra(AlarmClock.EXTRA_MINUTES, minute)
                        .putExtra(AlarmClock.EXTRA_MESSAGE, label)
                        .putExtra(AlarmClock.EXTRA_SKIP_UI, false);
                if (days != null) intent.putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, days);
                return intent;
            }
            case "show":
            case "dismiss":
                if (hour != null || minute != null || label != null || snoozeMinutes != null)
                    throw new IllegalArgumentException("Unexpected Clock options");
                return new Intent("show".equals(action) ? AlarmClock.ACTION_SHOW_ALARMS : AlarmClock.ACTION_DISMISS_ALARM);
            case "snooze":
                if (hour != null || minute != null || label != null || snoozeMinutes == null || snoozeMinutes < 1 || snoozeMinutes > 60)
                    throw new IllegalArgumentException("Choose 1 to 60 snooze minutes");
                return new Intent(AlarmClock.ACTION_SNOOZE_ALARM).putExtra(AlarmClock.EXTRA_ALARM_SNOOZE_DURATION, snoozeMinutes);
            default:
                throw new IllegalArgumentException("Unsupported Clock action");
        }
    }

    /** The package that receives a handoff, or null when nothing resolved or the host itself would. */
    public static String receiver(String ownPackage, String resolvedPackage) {
        if (resolvedPackage == null || resolvedPackage.isEmpty() || resolvedPackage.equals(ownPackage)) return null;
        return resolvedPackage;
    }

    /** Whether the host Activity is in front and the phone unlocked; a handoff starts only then. */
    public static boolean foreground(Activity activity) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed() || !activity.hasWindowFocus()) return false;
        KeyguardManager keyguard = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard == null || !keyguard.isKeyguardLocked();
    }

    /** Whether {@code timeZone} is still the phone's zone (canonical IDs compared). */
    public static boolean sameTimeZone(String timeZone) {
        if (timeZone == null) return false;
        String requested = android.icu.util.TimeZone.getCanonicalID(timeZone);
        String current = android.icu.util.TimeZone.getCanonicalID(java.util.TimeZone.getDefault().getID());
        return requested != null && requested.equals(current);
    }

    /**
     * Resolves {@code target}, binds the external handler and starts it. Returns OPENED with the
     * receiving package, UNAVAILABLE when no other app handles it, FAILED when
     * {@code requiredTimeZone} is set and is no longer the phone's zone (or the action is not a
     * set), DENIED or UNKNOWN on a failed start. The caller has already reviewed the request and
     * checked {@link #foreground}.
     */
    public static Result start(Activity activity, String action, Intent target, String requiredTimeZone, String openedMessage) {
        try {
            ResolveInfo resolved = activity.getPackageManager().resolveActivity(target, 0);
            String receiver = resolved == null || resolved.activityInfo == null ? null : receiver(activity.getPackageName(), resolved.activityInfo.packageName);
            if (receiver == null) return result(action, Status.UNAVAILABLE, "No installed Clock app handles this action");
            if (requiredTimeZone != null && (!"set".equals(action) || !sameTimeZone(requiredTimeZone)))
                return result(action, Status.FAILED, "Phone time zone changed. Review the Clock request again.");
            target.setComponent(new ComponentName(receiver, resolved.activityInfo.name));
            activity.startActivity(target);
            return new Result(action, Status.OPENED, openedMessage, receiver);
        } catch (ActivityNotFoundException missing) {
            return result(action, Status.UNAVAILABLE, "The Clock app is no longer available");
        } catch (SecurityException denied) {
            return result(action, Status.DENIED, "Android did not allow this Clock action");
        } catch (RuntimeException unknown) {
            return result(action, Status.UNKNOWN, "Clock result is unknown. Check Clock before trying again.");
        }
    }

    /**
     * A host's own reviewed Clock form: validates, requires the foreground unlocked host and an
     * unchanged time zone for a set, then {@link #start}s. {@code productName} names the host in
     * its messages.
     */
    public static Result launch(Activity activity, String productName, String action, Integer hour, Integer minute, String label,
                                Integer snoozeMinutes, boolean reviewed, String timeZone, List<Integer> repeatDays) {
        if (!reviewed) return result(action, Status.FAILED, "Review the Clock request before continuing");
        Intent target;
        try {
            target = intent(action, hour, minute, label, snoozeMinutes, repeatDays);
        } catch (IllegalArgumentException invalid) {
            return result(action, Status.FAILED, invalid.getMessage());
        }
        try {
            if (activity == null || activity.isFinishing() || activity.isDestroyed() || !activity.hasWindowFocus())
                return result(action, Status.FAILED, "Open " + productName + " before continuing to Clock");
            if (!foreground(activity)) return result(action, Status.FAILED, "Unlock the phone before continuing to Clock");
        } catch (RuntimeException unknown) {
            return result(action, Status.UNKNOWN, "Clock result is unknown. Check Clock before trying again.");
        }
        return start(activity, action, target, timeZone, "Clock request sent. Check the Clock app; " + productName + " cannot confirm an alarm was changed.");
    }
}
