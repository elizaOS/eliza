// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"; spec/os/android/calendar.md, "A confirmed deletion is staged on the review clock and dispatched only through its claim"
package ai.eliza.plugins.calendar;

import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.OperationApplicationException;
import android.database.Cursor;
import android.net.Uri;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * CalendarProvider stand-in for host-JVM checks. Each query's projection, selection, arguments and
 * sort run as SQL in the sqlite3 shell over tables with CalendarProvider's column names, and a batch
 * applies the provider's assert, expected-count, delete and exception-insert rules before expanding
 * the instances again. It is not Android CalendarProvider, a permission check or a device run.
 */
final class SqliteCalendarProvider extends ContentResolver {
  private static final String UNIT = "\u001f", RECORD = "\u001e";
  private static final String SCHEMA = "CREATE TABLE calendars(_id INTEGER PRIMARY KEY,account_name TEXT,account_type TEXT,name TEXT,calendar_displayName TEXT,calendar_access_level INTEGER,ownerAccount TEXT);"
    + "CREATE TABLE events(_id INTEGER PRIMARY KEY,calendar_id INTEGER,title TEXT,description TEXT,eventLocation TEXT,dtstart INTEGER,dtend INTEGER,duration TEXT,eventTimezone TEXT,allDay INTEGER DEFAULT 0,rrule TEXT,rdate TEXT,exrule TEXT,exdate TEXT,"
    + "original_id INTEGER,original_sync_id TEXT,originalInstanceTime INTEGER,originalAllDay INTEGER,eventStatus INTEGER DEFAULT 1,deleted INTEGER DEFAULT 0,hasAlarm INTEGER DEFAULT 0,hasAttendeeData INTEGER DEFAULT 0,availability INTEGER DEFAULT 0,"
    + "accessLevel INTEGER DEFAULT 0,organizer TEXT,_sync_id TEXT,selfAttendeeStatus INTEGER DEFAULT 0);"
    + "CREATE TABLE attendees(_id INTEGER PRIMARY KEY,event_id INTEGER,attendeeName TEXT,attendeeEmail TEXT,attendeeRelationship INTEGER,attendeeType INTEGER,attendeeStatus INTEGER,attendeeIdentity TEXT,attendeeIdNamespace TEXT);"
    + "CREATE TABLE reminders(_id INTEGER PRIMARY KEY,event_id INTEGER,minutes INTEGER,method INTEGER);"
    + "CREATE TABLE instances(event_id INTEGER,\"begin\" INTEGER,\"end\" INTEGER);";
  private static final String EXPAND = "DELETE FROM instances WHERE event_id NOT IN (SELECT _id FROM events WHERE deleted=0 AND eventStatus!=2);"
    + "DELETE FROM instances WHERE EXISTS(SELECT 1 FROM events e WHERE e._id=instances.event_id AND instr(IFNULL(e.exdate,''),strftime('%Y%m%dT%H%M%SZ',instances.\"begin\"/1000,'unixepoch'))>0);"
    + "DELETE FROM instances WHERE EXISTS(SELECT 1 FROM events x WHERE x.original_id=instances.event_id AND x.originalInstanceTime=instances.\"begin\" AND x.deleted=0);";
  private final String database;
  Runnable beforeBatch = () -> {};
  boolean loseReply;
  int batches;

  SqliteCalendarProvider(Path directory) {
    database = directory.resolve("provider-" + System.nanoTime() + ".db").toString();
    sql(SCHEMA);
  }

  String sql(String statements) {
    try {
      Process process = new ProcessBuilder("sqlite3", "-batch", "-noheader", "-separator", UNIT, "-newline", RECORD, database, statements).redirectErrorStream(true).start();
      String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      if (process.waitFor() != 0) throw new IllegalStateException("sqlite3 refused: " + output + "\n" + statements);
      return output;
    } catch (RuntimeException failure) {
      throw failure;
    } catch (Exception failure) {
      throw new IllegalStateException(failure);
    }
  }

  private static String literal(Object value) {
    if (value == null) return "NULL";
    if (value instanceof Boolean flag) return flag ? "1" : "0";
    if (value instanceof Number) return value.toString();
    return "'" + value.toString().replace("'", "''") + "'";
  }

  private static String column(String name) {
    if (!name.matches("[A-Za-z_][A-Za-z_0-9]*")) throw new AssertionError("Not a plain column: " + name);
    return "[" + name + "]";
  }

  void insert(String table, Object... pairs) {
    StringBuilder columns = new StringBuilder(), values = new StringBuilder();
    for (int i = 0; i < pairs.length; i += 2) {
      if (i > 0) { columns.append(','); values.append(','); }
      columns.append(column((String) pairs[i]));
      values.append(literal(pairs[i + 1]));
    }
    sql("INSERT INTO " + table + "(" + columns + ") VALUES(" + values + ");");
  }

  private record Target(String table, String scope) {}

  private static Target target(Uri uri) {
    List<String> path = uri.getPathSegments();
    if (!"com.android.calendar".equals(uri.getAuthority()) || path.isEmpty()) throw new AssertionError("Not a CalendarProvider URI: " + uri);
    String table = path.get(0);
    if (table.equals("instances")) {
      if (path.size() != 4 || !path.get(1).equals("when")) throw new AssertionError("Instances need a range: " + uri);
      return new Target("instances", "\"begin\"<=" + Long.parseLong(path.get(3)) + " AND \"end\">=" + Long.parseLong(path.get(2)));
    }
    if (!table.matches("calendars|events|attendees|reminders") || path.size() > 2) throw new AssertionError("Provider URI: " + uri);
    return new Target(table, path.size() == 2 ? "_id=" + Long.parseLong(path.get(1)) : "1");
  }

  private static String bound(String selection, String[] arguments) {
    if (selection == null) return "1";
    StringBuilder text = new StringBuilder();
    int used = 0;
    for (char c : selection.toCharArray()) {
      if (c != '?') { text.append(c); continue; }
      if (arguments == null || used >= arguments.length) throw new AssertionError("Unbound placeholder in " + selection);
      String argument = arguments[used++];
      text.append(argument.matches("-?[0-9]{1,19}") ? argument : literal(argument));
    }
    if (used != (arguments == null ? 0 : arguments.length)) throw new AssertionError("Unused arguments for " + selection);
    return text.toString();
  }

  private String where(Uri uri, String selection, String[] arguments) {
    Target target = target(uri);
    return target.table() + " WHERE (" + target.scope() + ") AND (" + bound(selection, arguments) + ")";
  }

  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] arguments, String sort) {
    StringBuilder columns = new StringBuilder();
    for (String name : projection) {
      if (columns.length() > 0) columns.append(',');
      columns.append(column(name)).append(",typeof(").append(column(name)).append(')');
    }
    String output = sql("SELECT " + columns + " FROM " + where(uri, selection, arguments) + (sort == null ? "" : " ORDER BY " + sort) + ";");
    List<String[]> rows = new ArrayList<>();
    for (String record : output.split(RECORD, -1)) {
      if (record.isEmpty()) continue;
      String[] cells = record.split(UNIT, -1);
      if (cells.length != projection.length * 2) throw new AssertionError("Incomplete provider row");
      rows.add(cells);
    }
    return new Rows(rows);
  }

  int count(String table, String condition) {
    return Integer.parseInt(sql("SELECT count(*) FROM " + table + " WHERE " + condition + ";").replace(RECORD, "").trim());
  }

  String value(String sql) {
    return sql(sql).replace(RECORD, "");
  }

  @Override public ContentProviderResult[] applyBatch(String authority, ArrayList<ContentProviderOperation> operations) throws OperationApplicationException {
    if (!authority.equals("com.android.calendar")) throw new AssertionError("Wrong authority " + authority);
    batches++;
    beforeBatch.run();
    ContentProviderResult[] results = new ContentProviderResult[operations.size()];
    StringBuilder writes = new StringBuilder("BEGIN;");
    for (int i = 0; i < operations.size(); i++) {
      ContentProviderOperation operation = operations.get(i);
      if (operation.kind == ContentProviderOperation.Kind.INSERT) {
        List<String> path = operation.uri.getPathSegments();
        if (!path.get(0).equals("exception") || path.size() != 2) throw new AssertionError("Only exception inserts are expected: " + operation.uri);
        long parent = Long.parseLong(path.get(1));
        long id = Long.parseLong(value("SELECT IFNULL(max(_id),0)+1 FROM events;")) + i;
        Object instance = operation.values.get("originalInstanceTime");
        writes.append("INSERT INTO events(_id,calendar_id,title,description,eventLocation,dtstart,dtend,eventTimezone,original_id,original_sync_id,originalInstanceTime,eventStatus) SELECT ")
          .append(id).append(",calendar_id,title,description,eventLocation,").append(literal(instance)).append(',').append(literal(instance)).append(",eventTimezone,_id,_sync_id,")
          .append(literal(instance)).append(',').append(literal(operation.values.get("eventStatus"))).append(" FROM events WHERE _id=").append(parent).append(';');
        results[i] = new ContentProviderResult(Uri.parse("content://com.android.calendar/events/" + id));
        continue;
      }
      String selected = where(operation.uri, operation.selection, operation.arguments);
      int matched = Integer.parseInt(sql("SELECT count(*) FROM " + selected + ";").replace(RECORD, "").trim());
      if (operation.expectedCount != null && matched != operation.expectedCount) throw new OperationApplicationException("Expected " + operation.expectedCount + " rows, found " + matched + " for " + operation.uri);
      results[i] = new ContentProviderResult(matched);
      String table = selected.substring(0, selected.indexOf(' ')), condition = selected.substring(selected.indexOf(" WHERE ") + 7);
      switch (operation.kind) {
        case ASSERT -> {
          if (operation.values == null) break;
          StringBuilder same = new StringBuilder(condition);
          for (String key : operation.values.keySet()) {
            Object expected = operation.values.get(key);
            same.append(" AND ").append(expected == null ? column(key) + " IS NULL" : "CAST(" + column(key) + " AS TEXT)=" + literal(expected.toString()));
          }
          if (count(table, same.toString()) != matched) throw new OperationApplicationException("Changed row for " + operation.uri);
        }
        case UPDATE -> {
          StringBuilder set = new StringBuilder();
          for (String key : operation.values.keySet()) set.append(set.length() == 0 ? "" : ",").append(column(key)).append('=').append(literal(operation.values.get(key)));
          writes.append("UPDATE ").append(table).append(" SET ").append(set).append(" WHERE ").append(condition).append(';');
        }
        case DELETE -> {
          if (!table.equals("events")) throw new AssertionError("Only event deletes are expected");
          writes.append("DELETE FROM events WHERE _sync_id IS NULL AND (_id IN (SELECT _id FROM ").append(selected).append(") OR original_id IN (SELECT _id FROM ").append(selected).append("));")
            .append("UPDATE events SET deleted=1 WHERE _id IN (SELECT _id FROM ").append(selected).append(") OR original_id IN (SELECT _id FROM ").append(selected).append(");");
        }
        default -> throw new AssertionError("Unexpected operation");
      }
    }
    sql(writes.append(EXPAND).append("COMMIT;").toString());
    if (loseReply) throw new IllegalStateException("The provider's reply was lost");
    return results;
  }

  static final class Rows implements Cursor {
    private final List<String[]> rows;
    private int at = -1;
    Rows(List<String[]> rows) { this.rows = rows; }
    private String value(int column) { return rows.get(at)[column * 2]; }
    private String type(int column) { return rows.get(at)[column * 2 + 1]; }
    @Override public boolean moveToFirst() { at = 0; return !rows.isEmpty(); }
    @Override public boolean moveToNext() { return ++at < rows.size(); }
    @Override public int getCount() { return rows.size(); }
    @Override public boolean isNull(int column) { return type(column).equals("null"); }
    @Override public int getType(int column) { return isNull(column) ? FIELD_TYPE_NULL : type(column).equals("integer") ? FIELD_TYPE_INTEGER : FIELD_TYPE_STRING; }
    @Override public long getLong(int column) { return Long.parseLong(value(column)); }
    @Override public int getInt(int column) { return Integer.parseInt(value(column)); }
    @Override public String getString(int column) { return isNull(column) ? null : value(column); }
    @Override public void close() {}
  }
}
