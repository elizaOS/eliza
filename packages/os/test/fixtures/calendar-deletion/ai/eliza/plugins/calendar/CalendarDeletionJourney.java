// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"; spec/os/android/calendar.md, "The provider resolves the selected instance and decides the permitted scope"; spec/os/android/calendar.md, "A confirmed deletion is staged on the review clock and dispatched only through its claim"
package ai.eliza.plugins.calendar;

import android.app.KeyguardManager;
import android.content.ContentResolver;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Walks the compiled ElizaCalendar plugin through each deletion the bridge stages: one event, one
 * occurrence of a local or synced series, a moved exception, the whole series, and every refusal.
 * The arguments are the method names the bridge's AndroidCalendarPlugin declares; each must be a
 * plugin method of the compiled class. Prints one JSON object of what the plugin answered and what
 * the provider holds after.
 */
public final class CalendarDeletionJourney {
  static final long HOUR = 3_600_000L, WEEK = 7 * 24 * HOUR, FIRST = 1_791_766_800_000L;
  static final CalendarConfiguration CONFIGURATION = new CalendarConfiguration("Phone", "phone-local", "On this phone", "calendar-deletion-journey", "eliza://calendar-creation/", 0xff0000ff);

  static final class Host extends Context {
    final SqliteCalendarProvider provider;
    final KeyguardManager keyguard = new KeyguardManager();
    Host(SqliteCalendarProvider provider) { this.provider = provider; }
    @Override public ContentResolver getContentResolver() { return provider; }
    @Override public Object getSystemService(String name) { return Context.KEYGUARD_SERVICE.equals(name) ? keyguard : null; }
  }

  private final Path directory;
  private final CalendarPlugin plugin = new CalendarPlugin(CONFIGURATION) {};
  private Host host;

  CalendarDeletionJourney(Path directory) { this.directory = directory; }

  private SqliteCalendarProvider phone() {
    SqliteCalendarProvider provider = new SqliteCalendarProvider(directory);
    provider.insert("calendars", "_id", 7L, "account_name", "Phone", "account_type", "LOCAL", "name", "phone-local", "calendar_displayName", "On this phone", "calendar_access_level", 700L, "ownerAccount", "Phone");
    provider.insert("calendars", "_id", 8L, "account_name", "owner@example.com", "account_type", "com.google", "name", "owner@example.com", "calendar_displayName", "Work", "calendar_access_level", 700L, "ownerAccount", "owner@example.com");
    provider.insert("calendars", "_id", 9L, "account_name", "owner@example.org", "account_type", "com.example.exchange", "name", "Exchange", "calendar_displayName", "Exchange", "calendar_access_level", 700L, "ownerAccount", "owner@example.org");
    provider.insert("calendars", "_id", 10L, "account_name", "holidays", "account_type", "com.google", "name", "Holidays", "calendar_displayName", "Holidays", "calendar_access_level", 200L, "ownerAccount", "holidays");
    single(provider, 1, 7, "Probe single", FIRST);
    single(provider, 2, 7, "Probe single conflict", FIRST + 2 * HOUR);
    weekly(provider, 3, 7, "Probe weekly", null);
    weekly(provider, 5, 8, "Team sync", "sync-5");
    provider.insert("events", "_id", 6L, "calendar_id", 8L, "title", "Team sync (moved)", "dtstart", FIRST + WEEK + 2 * HOUR, "dtend", FIRST + WEEK + 3 * HOUR, "eventTimezone", "UTC", "original_id", 5L, "original_sync_id", "sync-5", "originalInstanceTime", FIRST + WEEK, "_sync_id", "sync-6");
    provider.sql("DELETE FROM instances WHERE event_id=5 AND \"begin\"=" + (FIRST + WEEK) + ";");
    provider.insert("instances", "event_id", 6L, "begin", FIRST + WEEK + 2 * HOUR, "end", FIRST + WEEK + 3 * HOUR);
    provider.insert("attendees", "_id", 1L, "event_id", 5L, "attendeeEmail", "guest@example.com", "attendeeStatus", 1L);
    provider.insert("reminders", "_id", 1L, "event_id", 5L, "minutes", 10L, "method", 1L);
    weekly(provider, 11, 9, "Exchange standup", null);
    single(provider, 12, 10, "Holiday", FIRST);
    weekly(provider, 13, 7, "Probe weekly with an edit", null);
    provider.insert("events", "_id", 14L, "calendar_id", 7L, "title", "Probe weekly with an edit", "dtstart", FIRST + 2 * WEEK + HOUR, "dtend", FIRST + 2 * WEEK + 2 * HOUR, "eventTimezone", "UTC", "original_id", 13L, "originalInstanceTime", FIRST + 2 * WEEK);
    return provider;
  }

  private static void single(SqliteCalendarProvider provider, long id, long calendar, String title, long begin) {
    provider.insert("events", "_id", id, "calendar_id", calendar, "title", title, "description", "", "eventLocation", "", "dtstart", begin, "dtend", begin + HOUR, "eventTimezone", "UTC");
    provider.insert("instances", "event_id", id, "begin", begin, "end", begin + HOUR);
  }

  private static void weekly(SqliteCalendarProvider provider, long id, long calendar, String title, String syncId) {
    provider.insert("events", "_id", id, "calendar_id", calendar, "title", title, "dtstart", FIRST, "duration", "PT1H", "eventTimezone", "UTC", "rrule", "FREQ=WEEKLY;COUNT=4", "_sync_id", syncId);
    for (int week = 0; week < 4; week++) provider.insert("instances", "event_id", id, "begin", FIRST + week * WEEK, "end", FIRST + week * WEEK + HOUR);
  }

  private void fresh() {
    host = new Host(phone());
    Plugin.context = host;
    Plugin.permission = PermissionState.GRANTED;
    Plugin.activity.focused = true;
  }

  private JSObject call(String method, JSObject data) throws Exception {
    PluginCall call = new PluginCall(data);
    plugin.getClass().getMethod(method, PluginCall.class).invoke(plugin, call);
    if (call.rejected != null) return new JSObject().put("rejected", call.rejected);
    return call.result;
  }

  private static JSObject selection(long id, long calendar, String title, long begin, String scope) {
    JSObject selection = new JSObject().put("id", Long.toString(id)).put("calendarId", Long.toString(calendar))
      .put("expected", new JSObject().put("title", title).put("body", "").put("location", "").put("begin", begin).put("end", begin + HOUR));
    return scope == null ? selection : selection.put("scope", scope);
  }

  private JSObject inspect(long id, long calendar, String title, long begin, String scope) throws Exception {
    return call("inspectDeletion", selection(id, calendar, title, begin, scope));
  }

  private JSObject dispatch(long id, long calendar, JSObject inspected, String change, long originalStart) throws Exception {
    return call("dispatchDeletion", new JSObject().put("id", Long.toString(id)).put("calendarId", Long.toString(calendar))
      .put("revision", inspected.optString("revision")).put("sourceRevision", inspected.optString("sourceRevision")).put("change", change).put("originalStart", originalStart));
  }

  private static JSONObject shown(JSONObject reply) throws Exception {
    JSONObject shown = new JSONObject(reply.toString());
    for (String key : new String[] {"revision", "sourceRevision"}) if (shown.has(key)) shown.put(key, shown.getString(key).matches("[0-9a-f]{64}") ? "sha256" : shown.get(key));
    return shown;
  }

  private JSONObject provider(long... ids) throws Exception {
    JSONObject state = new JSONObject();
    for (long id : ids) {
      String row = host.provider.value("SELECT json_object('title',title,'deleted',deleted,'status',eventStatus,'exdate',exdate) FROM events WHERE _id=" + id + ";");
      JSONArray instances = new JSONArray();
      for (String begin : host.provider.value("SELECT group_concat((\"begin\"-" + FIRST + ")/" + HOUR + ",',') FROM instances WHERE event_id=" + id + " ORDER BY \"begin\";").split(","))
        if (!begin.isEmpty()) instances.put(Long.parseLong(begin));
      state.put(Long.toString(id), new JSONObject().put("row", row.isEmpty() ? JSONObject.NULL : new JSONObject(row)).put("instanceHours", instances));
    }
    state.put("exceptionsOf5", host.provider.count("events", "original_id=5"));
    state.put("batches", host.provider.batches);
    return state;
  }

  private JSONObject journeys() throws Exception {
    JSONObject out = new JSONObject();

    fresh();
    JSObject single = inspect(1, 7, "Probe single", FIRST, "event");
    JSObject deleted = dispatch(1, 7, single, "DeleteRow", -1);
    JSObject again = dispatch(1, 7, single, "DeleteRow", -1);
    out.put("single", new JSONObject().put("inspected", shown(single)).put("dispatched", deleted).put("again", again).put("after", provider(1, 2)));

    fresh();
    JSObject reviewed = inspect(2, 7, "Probe single conflict", FIRST + 2 * HOUR, "event");
    host.provider.sql("UPDATE events SET title='Probe single conflict, moved' WHERE _id=2;");
    out.put("singleChangedSince", new JSONObject().put("dispatched", dispatch(2, 7, reviewed, "DeleteRow", -1))
      .put("staleSelection", inspect(2, 7, "Probe single conflict", FIRST + 2 * HOUR, "event")).put("after", provider(2)));

    fresh();
    JSObject occurrence = inspect(3, 7, "Probe weekly", FIRST + WEEK, "occurrence");
    out.put("localOccurrence", new JSONObject().put("inspected", shown(occurrence)).put("dispatched", dispatch(3, 7, occurrence, "ExcludeOccurrence", FIRST + WEEK)).put("after", provider(3)));

    fresh();
    JSObject series = inspect(3, 7, "Probe weekly", FIRST + WEEK, "series");
    out.put("wholeSeries", new JSONObject().put("inspected", shown(series)).put("dispatched", dispatch(3, 7, series, "DeleteRow", -1)).put("after", provider(3)));

    fresh();
    JSObject before = inspect(3, 7, "Probe weekly", FIRST + WEEK, "occurrence");
    host.provider.sql("UPDATE events SET rrule='FREQ=WEEKLY;COUNT=5' WHERE _id=3;");
    out.put("seriesChangedSince", new JSONObject().put("dispatched", dispatch(3, 7, before, "ExcludeOccurrence", FIRST + WEEK)).put("after", provider(3)));

    fresh();
    JSObject raced = inspect(3, 7, "Probe weekly", FIRST + WEEK, "occurrence");
    host.provider.beforeBatch = () -> host.provider.sql("UPDATE events SET title='Probe weekly, renamed' WHERE _id=3;");
    out.put("changedDuringBatch", new JSONObject().put("dispatched", dispatch(3, 7, raced, "ExcludeOccurrence", FIRST + WEEK)).put("after", provider(3)));

    fresh();
    JSObject cancelled = inspect(5, 8, "Team sync", FIRST, "occurrence");
    out.put("syncedOccurrence", new JSONObject().put("inspected", shown(cancelled)).put("dispatched", dispatch(5, 8, cancelled, "InsertCancelledOccurrence", FIRST)).put("after", provider(5)));

    fresh();
    JSObject moved = inspect(6, 8, "Team sync (moved)", FIRST + WEEK + 2 * HOUR, null);
    out.put("movedException", new JSONObject().put("inspected", shown(moved)).put("dispatched", dispatch(6, 8, moved, "CancelOccurrence", FIRST + WEEK)).put("after", provider(5, 6)));

    fresh();
    JSObject remote = inspect(11, 9, "Exchange standup", FIRST, "occurrence"), synced = inspect(5, 8, "Team sync", FIRST, "occurrence");
    out.put("changeTheFamilyRefuses", new JSONObject()
      .put("excludeRemote", dispatch(11, 9, remote, "ExcludeOccurrence", FIRST)).put("insertRemote", dispatch(11, 9, remote, "InsertCancelledOccurrence", FIRST))
      .put("deleteWithAnOccurrence", dispatch(11, 9, remote, "DeleteRow", FIRST)).put("cancelTheParent", dispatch(5, 8, synced, "CancelOccurrence", FIRST))
      .put("excludeSynced", dispatch(5, 8, synced, "ExcludeOccurrence", FIRST)).put("after", provider(5, 11)));

    fresh();
    out.put("editorEvidence", new JSONObject()
      .put("remoteUnsynced", shown(inspect(11, 9, "Exchange standup", FIRST, "occurrence")))
      .put("readOnly", shown(inspect(12, 10, "Holiday", FIRST, null)))
      .put("localWithAnEdit", shown(inspect(13, 7, "Probe weekly with an edit", FIRST + WEEK, "occurrence")))
      .put("notAnInstance", shown(inspect(1, 7, "Probe single", FIRST + HOUR, "event"))));

    fresh();
    JSObject granted = inspect(1, 7, "Probe single", FIRST, "event");
    Plugin.permission = PermissionState.DENIED;
    JSObject deniedInspect = inspect(1, 7, "Probe single", FIRST, "event"), deniedDispatch = dispatch(1, 7, granted, "DeleteRow", -1);
    out.put("permissionRequired", new JSONObject().put("inspected", deniedInspect).put("dispatched", deniedDispatch).put("after", provider(1)));

    fresh();
    JSObject reviewedUnlocked = inspect(1, 7, "Probe single", FIRST, "event");
    host.keyguard.locked = true;
    Plugin.activity.focused = false;
    out.put("lockedAfterReview", new JSONObject().put("inspected", inspect(1, 7, "Probe single", FIRST, "event")).put("dispatched", dispatch(1, 7, reviewedUnlocked, "DeleteRow", -1)).put("after", provider(1)));

    fresh();
    JSObject lost = inspect(1, 7, "Probe single", FIRST, "event");
    host.provider.loseReply = true;
    out.put("replyLost", new JSONObject().put("dispatched", dispatch(1, 7, lost, "DeleteRow", -1)).put("after", provider(1)));

    return out;
  }

  public static void main(String[] args) throws Exception {
    JSONArray missing = new JSONArray();
    for (String method : args) {
      java.lang.reflect.Method found = null;
      try { found = CalendarPlugin.class.getMethod(method, PluginCall.class); } catch (NoSuchMethodException absent) { }
      if (found == null || !found.isAnnotationPresent(PluginMethod.class)) missing.put(method);
    }
    Path directory = Files.createTempDirectory("calendar-deletion-journey-");
    JSONObject out = new JSONObject().put("missing", missing);
    try {
      out.put("journeys", missing.isEmpty() ? new CalendarDeletionJourney(directory).journeys() : JSONObject.NULL);
    } finally {
      try (var files = Files.walk(directory)) { files.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete()); }
    }
    System.out.println(out.toString(1));
  }
}
