package ai.eliza.plugins.calendar;

import ai.eliza.plugins.calendar.write.CalendarEventOptions;
import android.content.ContentProviderOperation;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.OperationApplicationException;
import android.database.Cursor;
import android.provider.CalendarContract;
import java.util.ArrayList;

/**
 * Guarded changes to one existing event, for a host that has its own bridge and has already
 * confirmed the change with the user. No UI, permission or agent policy. Each change is one
 * atomic provider batch that asserts the calendar and event rows still match the revision the
 * host read. Deleted and repeating events and calendars that cannot be written are refused.
 */
public final class CalendarEventEdits {
 private CalendarEventEdits() {}

 /** Why a change was refused. Nothing was written. */
 public enum Reason { GONE, READ_ONLY, REPEATING, CHANGED }

 public static final class Refused extends IllegalStateException {
  private static final long serialVersionUID = 1L;
  public final Reason reason;
  Refused(Reason reason, Throwable cause) { super("Calendar event change refused: " + reason, cause); this.reason = reason; }
 }

 /** Public read model of one event row and its calendar. */
 public static final class Event {
  public final long id, calendarId;
  /** Changes when any guarded event or calendar field changes. Pass it back to change the event. */
  public final String revision;
  public final boolean writable, repeating;
  Event(CalendarEventGuard.Snapshot snapshot) {
   id = snapshot.id; calendarId = snapshot.calendarId; revision = snapshot.revision;
   writable = snapshot.writable(); repeating = snapshot.repeating();
  }
 }

 /** The event, or null when it is not in the provider or is marked deleted. */
 public static Event snapshot(ContentResolver resolver, long eventId) throws Exception {
  CalendarEventGuard.Snapshot current = read(resolver, eventId);
  return current == null ? null : new Event(current);
 }

 /** Replaces the fields of a single event. The event stays in its calendar. Returns the new revision. */
 public static Event update(ContentResolver resolver, long eventId, String expectedRevision, CalendarEventOptions options) throws Exception {
  if (options == null || !options.rrule.isEmpty()) throw new IllegalArgumentException("A single event is required");
  CalendarEventGuard.Snapshot current = admitted(resolver, eventId, expectedRevision);
  ContentValues values = options.values(current.calendarId);
  values.remove(CalendarContract.Events.CALENDAR_ID);
  values.putNull(CalendarContract.Events.DURATION);
  ArrayList<ContentProviderOperation> operations = current.rowAssertions();
  operations.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId)).withValues(values).withExpectedCount(1).build());
  apply(resolver, operations);
  CalendarEventGuard.Snapshot after = CalendarEventGuard.read(resolver, eventId, current.calendarId);
  if (after == null || after.deleted()) throw new IllegalStateException("Calendar update readback unavailable");
  return new Event(after);
 }

 /** Deletes a single event. */
 public static void delete(ContentResolver resolver, long eventId, String expectedRevision) throws Exception {
  CalendarEventGuard.Snapshot current = admitted(resolver, eventId, expectedRevision);
  ArrayList<ContentProviderOperation> operations = current.rowAssertions();
  operations.add(ContentProviderOperation.newDelete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId)).withExpectedCount(1).build());
  apply(resolver, operations);
 }

 private static CalendarEventGuard.Snapshot admitted(ContentResolver resolver, long eventId, String expectedRevision) throws Exception {
  if (expectedRevision == null || expectedRevision.isEmpty()) throw new IllegalArgumentException("A revision is required");
  CalendarEventGuard.Snapshot current = read(resolver, eventId);
  if (current == null) throw new Refused(Reason.GONE, null);
  if (!current.writable()) throw new Refused(Reason.READ_ONLY, null);
  if (current.repeating()) throw new Refused(Reason.REPEATING, null);
  if (!current.revision.equals(expectedRevision)) throw new Refused(Reason.CHANGED, null);
  return current;
 }

 private static void apply(ContentResolver resolver, ArrayList<ContentProviderOperation> operations) throws Exception {
  try { resolver.applyBatch(CalendarContract.AUTHORITY, operations); }
  catch (OperationApplicationException changed) { throw new Refused(Reason.CHANGED, changed); }
 }

 private static CalendarEventGuard.Snapshot read(ContentResolver resolver, long eventId) throws Exception {
  if (eventId <= 0) throw new IllegalArgumentException("Invalid event");
  long calendarId;
  try (Cursor row = resolver.query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId), new String[]{CalendarContract.Events.CALENDAR_ID}, null, null, null)) {
   if (row == null) throw new IllegalStateException("Provider query unavailable");
   if (!row.moveToFirst() || row.isNull(0)) return null;
   calendarId = row.getLong(0);
  }
  CalendarEventGuard.Snapshot current = calendarId > 0 ? CalendarEventGuard.read(resolver, eventId, calendarId) : null;
  return current == null || current.deleted() ? null : current;
 }
}
