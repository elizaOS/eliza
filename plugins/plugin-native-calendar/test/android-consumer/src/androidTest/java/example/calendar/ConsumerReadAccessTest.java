package example.calendar;

import ai.eliza.plugins.calendar.read.CalendarReadAccess;
import android.Manifest;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Process;
import android.provider.CalendarContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Exercises the shared reader with real provider rows in an explicitly disposable user. */
@RunWith(AndroidJUnit4.class)
public final class ConsumerReadAccessTest {
  @Test public void completeReadAndReviewIntentDoNotWrite() throws Exception {
    org.junit.Assume.assumeTrue("Explicit secondary-user fixture required", "1".equals(
      InstrumentationRegistry.getArguments().getString("calendarReadAccess")));
    assertTrue("Never run as user 0", Process.myUid() / 100000 > 0);
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.READ_CALENDAR));
    assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.WRITE_CALENDAR));
    String name = "read-access-" + UUID.randomUUID();
    ContentValues calendar = new ContentValues();
    calendar.put("account_name", name); calendar.put("account_type", CalendarContract.ACCOUNT_TYPE_LOCAL);
    calendar.put("name", name); calendar.put("calendar_displayName", name); calendar.put("ownerAccount", name);
    calendar.put("calendar_access_level", CalendarContract.Calendars.CAL_ACCESS_OWNER);
    calendar.put("calendar_timezone", "UTC"); calendar.put("visible", 1); calendar.put("sync_events", 1);
    Uri calendars = CalendarContract.Calendars.CONTENT_URI.buildUpon()
      .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
      .appendQueryParameter("account_name", name).appendQueryParameter("account_type", CalendarContract.ACCOUNT_TYPE_LOCAL).build();
    Uri created = context.getContentResolver().insert(calendars, calendar); assertNotNull(created);
    long id = ContentUris.parseId(created), begin = System.currentTimeMillis() + 3600000, end = begin + 3 * 86400000L;
    try {
      for (int offset = 0; offset < 2101; offset += 100) {
        ContentValues[] batch = new ContentValues[Math.min(100, 2101 - offset)];
        for (int i = 0; i < batch.length; i++) {
          int index = offset + i; ContentValues event = new ContentValues();
          event.put("calendar_id", id); event.put("title", "Owned read fixture " + index);
          event.put("description", "Owned body"); event.put("eventLocation", "Owned location");
          event.put("dtstart", begin + index * 60000L); event.put("dtend", begin + index * 60000L + 30000);
          event.put("eventTimezone", "UTC"); batch[i] = event;
        }
        assertEquals(batch.length, context.getContentResolver().bulkInsert(CalendarContract.Events.CONTENT_URI, batch));
      }
      CalendarReadAccess reader = new CalendarReadAccess(context.getContentResolver());
      JSONArray sources = reader.calendars(); boolean found = false;
      for (int i = 0; i < sources.length(); i++) if (sources.getJSONObject(i).getString("id").equals(Long.toString(id))) {
        JSONObject source = sources.getJSONObject(i); found = true;
        assertEquals(name, source.getString("name")); assertTrue(source.getBoolean("writable")); assertTrue(source.getBoolean("local"));
      }
      assertTrue(found);
      JSONArray events = reader.events(begin, end); int count = 0; boolean last = false;
      for (int i = 0; i < events.length(); i++) if (events.getJSONObject(i).getString("calendarId").equals(Long.toString(id))) {
        JSONObject event = events.getJSONObject(i); count++;
        last |= event.getString("title").equals("Owned read fixture 2100");
        assertEquals("Owned body", event.getString("body")); assertFalse(event.getBoolean("recurring"));
      }
      assertEquals(2101, count); assertTrue(last);
      Intent review = CalendarReadAccess.reviewNewEvent("  Review only  ", begin, begin + 60000, "Desk");
      assertEquals(Intent.ACTION_INSERT, review.getAction()); assertEquals(CalendarContract.Events.CONTENT_URI, review.getData());
      assertEquals("Review only", review.getStringExtra(CalendarContract.Events.TITLE));
      assertEquals(begin, review.getLongExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, -1));
      assertEquals("Desk", review.getStringExtra(CalendarContract.Events.EVENT_LOCATION));
      assertEquals(events.toString(), reader.events(begin, end).toString());
      try { reader.events(end, begin); fail("Invalid range accepted"); } catch (IllegalArgumentException expected) { }
      try { CalendarReadAccess.reviewNewEvent(" ", begin, end, null); fail("Empty title accepted"); } catch (IllegalArgumentException expected) { }
    } finally {
      Uri exact = ContentUris.withAppendedId(calendars, id);
      assertEquals(1, context.getContentResolver().delete(exact, null, null));
    }
  }
}
