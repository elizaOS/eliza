package ai.eliza.plugins.calendar.write;

import android.content.ContentValues;
import android.provider.CalendarContract;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/**
 * Direct-save fields beyond a timed single event: all-day, an explicit IANA zone and a simple
 * RRULE. All-day events are UTC-midnight bounded with EVENT_TIMEZONE "UTC", as CalendarContract
 * requires. A recurring event stores DURATION instead of DTEND. Everything else is refused, and
 * the caller offers the ACTION_INSERT handoff instead.
 */
public final class CalendarEventOptions {
 private static final long DAY = 86400000L;
 public final String title, description, location, timeZone, rrule;
 public final boolean allDay;
 public final long begin, end;
 private CalendarEventOptions(String title, String description, String location, long begin, long end, boolean allDay, String timeZone, String rrule) {
  this.title = title; this.description = description; this.location = location; this.begin = begin; this.end = end; this.allDay = allDay; this.timeZone = timeZone; this.rrule = rrule;
 }
 private static String text(JSONObject input, String key, int maximum, boolean empty) {
  Object raw = input.opt(key);
  if (raw == null && empty) return "";
  if (!(raw instanceof String)) throw new IllegalArgumentException("Invalid " + key);
  String value = (String) raw;
  if (value.length() > maximum || value.indexOf(0) >= 0 || (!empty && value.trim().isEmpty())) throw new IllegalArgumentException("Invalid " + key);
  return value;
 }
 private static long instant(JSONObject input, String key) {
  Object raw = input.opt(key);
  if (!(raw instanceof Number)) throw new IllegalArgumentException("Invalid " + key);
  double value = ((Number) raw).doubleValue();
  if (!Double.isFinite(value) || value != Math.rint(value) || value < 0 || value > 8640000000000000L) throw new IllegalArgumentException("Invalid " + key);
  return (long) value;
 }
 /** A region-based IANA zone ("Area/Location") or UTC; offsets and abbreviations are refused. */
 public static String zone(String value) {
  if (value == null || value.length() > 128 || !(value.equals("UTC") || value.matches("[A-Za-z]+(?:/[A-Za-z0-9_+.-]+)+"))) throw new IllegalArgumentException("Choose a valid time zone");
  try { ZoneId.of(value); } catch (RuntimeException invalid) { throw new IllegalArgumentException("Choose a valid time zone"); }
  return value;
 }
 /** FREQ plus optional INTERVAL, BYDAY (weekly) and one of COUNT or UNTIL. Returned unchanged. */
 public static String rrule(String value, boolean allDay) {
  if (value == null || value.isEmpty()) return "";
  if (value.length() > 200) throw new IllegalArgumentException("Unsupported repeat rule");
  Set<String> seen = new HashSet<>(); String freq = null;
  for (String part : value.split(";", -1)) {
   int split = part.indexOf('=');
   if (split <= 0) throw new IllegalArgumentException("Unsupported repeat rule");
   String key = part.substring(0, split), field = part.substring(split + 1);
   if (!seen.add(key)) throw new IllegalArgumentException("Unsupported repeat rule");
   switch (key) {
    case "FREQ": if (!field.matches("DAILY|WEEKLY|MONTHLY|YEARLY")) throw new IllegalArgumentException("Unsupported repeat rule"); freq = field; break;
    case "INTERVAL": if (!field.matches("[1-9][0-9]?")) throw new IllegalArgumentException("Unsupported repeat rule"); break;
    case "COUNT": if (!field.matches("[1-9][0-9]{0,2}") || Integer.parseInt(field) > 730) throw new IllegalArgumentException("Unsupported repeat rule"); break;
    case "UNTIL": if (!(allDay ? field.matches("[0-9]{8}") : field.matches("[0-9]{8}T[0-9]{6}Z"))) throw new IllegalArgumentException("Unsupported repeat rule"); break;
    case "BYDAY": {
     if (!field.matches("(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*")) throw new IllegalArgumentException("Unsupported repeat rule");
     Set<String> days = new HashSet<>(); for (String day : field.split(",")) if (!days.add(day)) throw new IllegalArgumentException("Unsupported repeat rule");
     break;
    }
    default: throw new IllegalArgumentException("Unsupported repeat rule");
   }
  }
  if (!value.startsWith("FREQ=") || freq == null || seen.contains("COUNT") && seen.contains("UNTIL") || seen.contains("BYDAY") && !freq.equals("WEEKLY")) throw new IllegalArgumentException("Unsupported repeat rule");
  return value;
 }
 /** Fields: title, body, location, begin, end (epoch ms), allDay, timeZone, rrule. Exact keys. */
 public static CalendarEventOptions parse(JSONObject input) {
  if (input == null) throw new IllegalArgumentException("Invalid calendar event");
  Set<String> allowed = Set.of("title", "body", "location", "begin", "end", "allDay", "timeZone", "rrule");
  for (java.util.Iterator<String> keys = input.keys(); keys.hasNext();) if (!allowed.contains(keys.next())) throw new IllegalArgumentException("Unexpected calendar field");
  String title = text(input, "title", 500, false).trim(), body = text(input, "body", 16000, true), location = text(input, "location", 2000, true);
  long begin = instant(input, "begin"), end = instant(input, "end");
  Object rawAllDay = input.opt("allDay");
  if (!(rawAllDay instanceof Boolean)) throw new IllegalArgumentException("Invalid allDay");
  boolean allDay = (Boolean) rawAllDay;
  String zone = zone(text(input, "timeZone", 128, false));
  if (end <= begin || end - begin > 370L * DAY) throw new IllegalArgumentException("Choose an end after the start, within 370 days");
  if (allDay) {
   if (!zone.equals("UTC")) throw new IllegalArgumentException("All-day events use UTC dates");
   if (begin % DAY != 0 || end % DAY != 0) throw new IllegalArgumentException("All-day events start and end at a date boundary");
  }
  String rule = rrule(text(input, "rrule", 200, true), allDay);
  if (!rule.isEmpty() && (end - begin) % 1000 != 0) throw new IllegalArgumentException("Recurring duration must use whole seconds");
  if (!rule.isEmpty() && rule.contains("UNTIL=")) {
   String until = rule.replaceAll(".*UNTIL=([0-9TZ]+).*", "$1");
   long last = allDay ? java.time.LocalDate.parse(until, java.time.format.DateTimeFormatter.BASIC_ISO_DATE).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
    : Instant.from(java.time.format.DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmssX").withResolverStyle(java.time.format.ResolverStyle.STRICT).parse(until)).toEpochMilli();
   if (last < begin) throw new IllegalArgumentException("Repeat ends before the first event");
  }
  return new CalendarEventOptions(title, body, location, begin, end, allDay, zone, rule);
 }
 /** Exact provider values. A recurring event has DURATION and no DTEND. */
 public ContentValues values(long calendarId) {
  ContentValues values = new ContentValues();
  values.put(CalendarContract.Events.CALENDAR_ID, calendarId);
  values.put(CalendarContract.Events.TITLE, title);
  values.put(CalendarContract.Events.DESCRIPTION, description);
  values.put(CalendarContract.Events.EVENT_LOCATION, location);
  values.put(CalendarContract.Events.DTSTART, begin);
  values.put(CalendarContract.Events.EVENT_TIMEZONE, timeZone);
  values.put(CalendarContract.Events.ALL_DAY, allDay ? 1 : 0);
  if (rrule.isEmpty()) values.put(CalendarContract.Events.DTEND, end);
  else {
   values.put(CalendarContract.Events.RRULE, rrule);
   values.put(CalendarContract.Events.DURATION, allDay ? "P" + (end - begin) / DAY + "D" : "PT" + (end - begin) / 1000 + "S");
  }
  return values;
 }
}
