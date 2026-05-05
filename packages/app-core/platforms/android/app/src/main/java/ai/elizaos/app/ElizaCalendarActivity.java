package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.CalendarContract;

/**
 * Calendar entry point.
 *
 * AOSP Calendar is stripped. The CalendarContract provider stays,
 * so events written by other apps are still queryable; this activity
 * surfaces the Eliza calendar UI for both the launcher entry and
 * external ACTION_VIEW intents on event URIs.
 *
 * Common triggers:
 *   - User taps an event in an email — opens
 *     content://com.android.calendar/events/N.
 *   - Another app fires INSERT/EDIT on calendar events.
 */
public class ElizaCalendarActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        String action = source != null ? source.getAction() : null;
        Uri data = source != null ? source.getData() : null;

        Uri.Builder route = Uri.parse("ai.elizaos.app://calendar").buildUpon()
                .appendQueryParameter("source", "android-calendar");
        if (action != null) {
            route.appendQueryParameter("action", action);
        }
        if (data != null) {
            route.appendQueryParameter("uri", data.toString());
            String lastSegment = data.getLastPathSegment();
            if (lastSegment != null) {
                route.appendQueryParameter("eventId", lastSegment);
            }
        }
        if (source != null) {
            forwardExtra(route, source, CalendarContract.EXTRA_EVENT_BEGIN_TIME, "begin");
            forwardExtra(route, source, CalendarContract.EXTRA_EVENT_END_TIME, "end");
            forwardExtra(route, source, CalendarContract.EXTRA_EVENT_ALL_DAY, "allDay");
            forwardExtra(route, source, "title", "title");
            forwardExtra(route, source, "description", "description");
            forwardExtra(route, source, "eventLocation", "location");
        }

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }

    private static void forwardExtra(
            Uri.Builder route,
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
