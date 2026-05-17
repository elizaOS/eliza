package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.provider.AlarmClock;

/**
 * Clock / alarms / timers entry point.
 *
 * DeskClock is stripped. SET_ALARM and SHOW_ALARMS are critical for a
 * phone — third-party apps (calendar reminders, fitness apps, etc.)
 * fire SET_ALARM all the time. Without this activity, a phone shipping
 * ElizaOS literally cannot have alarms set programmatically.
 *
 * Routes to eliza://clock with the action and any extras
 * (HOUR/MINUTES/MESSAGE/RINGTONE/SKIP_UI) preserved so the WebView can
 * either show the alarm UI or, on SKIP_UI=true, schedule it directly
 * via the Eliza alarm service.
 */
public class ElizaClockActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        String action = source != null ? source.getAction() : null;

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);

        android.net.Uri.Builder route =
                android.net.Uri.parse("ai.elizaos.app://clock").buildUpon()
                        .appendQueryParameter("source", "android-clock");
        if (action != null) {
            route.appendQueryParameter("action", action);
        }
        if (source != null) {
            forwardExtra(route, source, AlarmClock.EXTRA_HOUR, "hour");
            forwardExtra(route, source, AlarmClock.EXTRA_MINUTES, "minutes");
            forwardExtra(route, source, AlarmClock.EXTRA_MESSAGE, "message");
            forwardExtra(route, source, AlarmClock.EXTRA_DAYS, "days");
            forwardExtra(route, source, AlarmClock.EXTRA_RINGTONE, "ringtone");
            forwardExtra(route, source, AlarmClock.EXTRA_SKIP_UI, "skipUi");
            forwardExtra(route, source, AlarmClock.EXTRA_VIBRATE, "vibrate");
            forwardExtra(route, source, AlarmClock.EXTRA_LENGTH, "length");
        }

        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }

    private static void forwardExtra(
            android.net.Uri.Builder route,
            Intent source,
            String extraKey,
            String paramName) {
        if (!source.hasExtra(extraKey)) {
            return;
        }
        Object value = source.getExtras().get(extraKey);
        if (value == null) {
            return;
        }
        route.appendQueryParameter(paramName, value.toString());
    }
}
