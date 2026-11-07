package ai.eliza.plugins.calendar.write;

import android.content.Intent;
import android.provider.CalendarContract;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One-tap ACTION_INSERT handoff for cases direct save does not support (attendees, alerts,
 * complex repeats). The external editor owns the save; a launch is never a save receipt.
 * Alert minutes have no standard insert extra and are reported back as not prefilled.
 */
public final class CalendarInsertHandoff {
 private static final Pattern EMAIL = Pattern.compile("[^\\s@,;<>]{1,64}@[^\\s@,;<>]{1,190}");
 private CalendarInsertHandoff() {}
 /** Fields: title, body, location, begin, end, allDay, timeZone, rrule (optional), attendees (emails), alerts (minutes). */
 public static Intent intent(JSONObject input) throws Exception {
  JSONObject event = new JSONObject();
  for (String key : new String[]{"title", "body", "location", "begin", "end", "allDay", "timeZone"}) if (input.has(key)) event.put(key, input.get(key));
  String rule = input.optString("rrule", "");
  if (!event.has("timeZone")) event.put("timeZone", "UTC");
  // The handoff accepts any rule the editor understands, but still refuses malformed text.
  if (rule.length() > 500 || rule.indexOf(0) >= 0 || !rule.isEmpty() && !rule.matches("[A-Z0-9=;,:+-]+")) throw new IllegalArgumentException("Unsupported repeat rule");
  CalendarEventOptions options = CalendarEventOptions.parse(event.put("rrule", ""));
  Intent intent = new Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
   .putExtra(CalendarContract.Events.TITLE, options.title).putExtra(CalendarContract.Events.DESCRIPTION, options.description).putExtra(CalendarContract.Events.EVENT_LOCATION, options.location)
   .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, options.begin).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, options.end).putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, options.allDay)
   .putExtra(CalendarContract.Events.EVENT_TIMEZONE, options.timeZone);
  if (!rule.isEmpty()) intent.putExtra(CalendarContract.Events.RRULE, rule);
  JSONArray attendees = input.optJSONArray("attendees");
  if (attendees != null && attendees.length() > 0) {
   if (attendees.length() > 50) throw new IllegalArgumentException("Too many guests");
   StringBuilder emails = new StringBuilder();
   for (int i = 0; i < attendees.length(); i++) { String email = attendees.getString(i).trim(); if (!EMAIL.matcher(email).matches()) throw new IllegalArgumentException("Invalid guest email"); if (emails.length() > 0) emails.append(','); emails.append(email); }
   intent.putExtra(Intent.EXTRA_EMAIL, emails.toString());
  }
  return intent;
 }
 /** Alerts requested by the draft that the editor must set itself. */
 public static boolean alertsNeedEditor(JSONObject input) { JSONArray alerts = input.optJSONArray("alerts"); return alerts != null && alerts.length() > 0; }
}
