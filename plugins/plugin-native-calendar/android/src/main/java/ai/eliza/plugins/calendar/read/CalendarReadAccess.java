package ai.eliza.plugins.calendar.read;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Read-only CalendarProvider access. Hosts own permission, source consent and presentation. */
public final class CalendarReadAccess {
  private static final java.util.regex.Pattern CREATION_ID =
    java.util.regex.Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
  private final ContentResolver resolver;
  private final String packageName, creationUriPrefix;

  public CalendarReadAccess(ContentResolver resolver) {
    this(resolver, null, null);
  }

  /**
   * Also returns {@code creationId} for events this host created through its creation journal
   * (custom app package and creation URI prefix). Provider row ids can be reused after a
   * deletion; the creation id stays with its event. It names a link, not an authority: any app
   * with calendar write access can set the same fields.
   */
  public CalendarReadAccess(ContentResolver resolver, String packageName, String creationUriPrefix) {
    this.resolver = java.util.Objects.requireNonNull(resolver);
    if ((packageName == null) != (creationUriPrefix == null) || (packageName != null && (packageName.isEmpty() || creationUriPrefix.isEmpty())))
      throw new IllegalArgumentException("Supply both the host package and creation URI prefix");
    this.packageName = packageName;
    this.creationUriPrefix = creationUriPrefix;
  }

  /** Event id to creation id for this host's journaled creations; empty when not configured. */
  private java.util.Map<Long, String> creations() {
    java.util.Map<Long, String> result = new java.util.HashMap<>();
    if (packageName == null) return result;
    String[] fields = {CalendarContract.Events._ID, CalendarContract.Events.CUSTOM_APP_URI};
    try (Cursor rows = resolver.query(CalendarContract.Events.CONTENT_URI, fields,
        CalendarContract.Events.CUSTOM_APP_PACKAGE + "=? AND " + CalendarContract.Events.DELETED + "=0",
        new String[]{packageName}, null)) {
      if (rows == null) throw new IllegalStateException("Calendar provider returned no cursor");
      while (rows.moveToNext()) {
        String uri = rows.getString(1);
        if (uri == null || !uri.startsWith(creationUriPrefix)) continue;
        String id = uri.substring(creationUriPrefix.length());
        if (CREATION_ID.matcher(id).matches()) result.put(rows.getLong(0), id);
      }
    }
    return result;
  }

  public JSONArray calendars() throws JSONException {
    JSONArray result = new JSONArray();
    String[] fields = {CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
      CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.ACCOUNT_NAME,
      CalendarContract.Calendars.ACCOUNT_TYPE};
    try (Cursor rows = resolver.query(CalendarContract.Calendars.CONTENT_URI, fields, null, null,
        CalendarContract.Calendars.CALENDAR_DISPLAY_NAME + " ASC")) {
      if (rows == null) throw new IllegalStateException("Calendar provider returned no cursor");
      while (rows.moveToNext()) {
        result.put(new JSONObject().put("id", Long.toString(rows.getLong(0))).put("name", rows.getString(1))
          .put("writable", rows.getInt(2) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR)
          .put("account", rows.getString(3)).put("local", CalendarContract.ACCOUNT_TYPE_LOCAL.equals(rows.getString(4))));
      }
    }
    return result;
  }

  /** Complete non-deleted instances in the authorized range; never silently truncates. */
  public JSONArray events(long begin, long end) throws JSONException {
    if (begin < 0 || end <= begin || end - begin > 370L * 86400000)
      throw new IllegalArgumentException("A valid calendar range of at most 370 days is required");
    Uri.Builder range = CalendarContract.Instances.CONTENT_URI.buildUpon();
    ContentUris.appendId(range, begin); ContentUris.appendId(range, end);
    String[] fields = {CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.CALENDAR_ID,
      CalendarContract.Instances.TITLE, CalendarContract.Instances.DESCRIPTION, CalendarContract.Instances.EVENT_LOCATION,
      CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.RRULE};
    JSONArray result = new JSONArray();
    java.util.Map<Long, String> creations = creations();
    try (Cursor rows = resolver.query(range.build(), fields, CalendarContract.Events.DELETED + "=0", null,
        CalendarContract.Instances.BEGIN + " ASC")) {
      if (rows == null) throw new IllegalStateException("Calendar provider returned no cursor");
      while (rows.moveToNext()) {
        String recurrence = rows.getString(8);
        JSONObject event = new JSONObject().put("id", Long.toString(rows.getLong(0))).put("calendarId", Long.toString(rows.getLong(1)))
          .put("title", rows.getString(2)).put("body", rows.getString(3)).put("location", rows.getString(4))
          .put("begin", rows.getLong(5)).put("end", rows.getLong(6)).put("allDay", rows.getInt(7) != 0)
          .put("recurring", recurrence != null && !recurrence.isEmpty());
        String creation = creations.get(rows.getLong(0));
        if (creation != null) event.put("creationId", creation);
        result.put(event);
      }
    }
    return result;
  }

  /** Constructs an editor request only. Dispatch and any eventual save remain user/host decisions. */
  public static Intent reviewNewEvent(String title, long start, long end, String location) {
    if (title == null || title.trim().isEmpty() || title.length() > 500 || start < 0 || end <= start)
      throw new IllegalArgumentException("Supply an event title and valid start/end times");
    return new Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
      .putExtra(CalendarContract.Events.TITLE, title.trim())
      .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
      .putExtra(CalendarContract.Events.EVENT_LOCATION, location == null ? "" : location);
  }
}
