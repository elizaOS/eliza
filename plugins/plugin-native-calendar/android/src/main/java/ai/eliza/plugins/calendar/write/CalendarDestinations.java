package ai.eliza.plugins.calendar.write;

import android.content.ContentUris;
import android.content.ContentValues;
import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import ai.eliza.plugins.calendar.CalendarConfiguration;
import java.util.TimeZone;

/** The host's local calendar (created on first use) and writable-destination checks. */
public final class CalendarDestinations {
 private CalendarDestinations() {}
 public static synchronized long local(ContentResolver resolver, CalendarConfiguration configuration) {
  String where = CalendarContract.Calendars.ACCOUNT_NAME + "=? AND " + CalendarContract.Calendars.ACCOUNT_TYPE + "=? AND " + CalendarContract.Calendars.NAME + "=?";
  try (Cursor rows = resolver.query(CalendarContract.Calendars.CONTENT_URI, new String[]{CalendarContract.Calendars._ID}, where, new String[]{configuration.accountName, CalendarContract.ACCOUNT_TYPE_LOCAL, configuration.localCalendarName}, null)) { if (rows == null) throw new IllegalStateException("Calendar lookup unavailable"); if (rows.moveToFirst()) return rows.getLong(0); }
  ContentValues v = new ContentValues(); v.put(CalendarContract.Calendars.ACCOUNT_NAME, configuration.accountName); v.put(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL); v.put(CalendarContract.Calendars.NAME, configuration.localCalendarName); v.put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, configuration.displayName); v.put(CalendarContract.Calendars.CALENDAR_COLOR, configuration.color); v.put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_OWNER); v.put(CalendarContract.Calendars.OWNER_ACCOUNT, configuration.accountName); v.put(CalendarContract.Calendars.CALENDAR_TIME_ZONE, TimeZone.getDefault().getID()); v.put(CalendarContract.Calendars.VISIBLE, 1); v.put(CalendarContract.Calendars.SYNC_EVENTS, 1);
  Uri uri = CalendarContract.Calendars.CONTENT_URI.buildUpon().appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true").appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, configuration.accountName).appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL).build();
  Uri inserted = resolver.insert(uri, v); if (inserted == null) throw new IllegalStateException("Calendar insert returned no URI"); return ContentUris.parseId(inserted);
 }
 public static boolean writable(ContentResolver resolver, long id) {
  try (Cursor row = resolver.query(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI, id), new String[]{CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}, null, null, null)) { return row != null && row.moveToFirst() && row.getInt(0) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR; }
 }
}
