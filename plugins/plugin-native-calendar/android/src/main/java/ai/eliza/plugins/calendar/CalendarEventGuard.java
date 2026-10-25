package ai.eliza.plugins.calendar;

import android.content.ContentProviderOperation;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.provider.CalendarContract;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import ai.eliza.plugins.calendar.read.CalendarSourceIdentity;
import org.json.JSONObject;

/** Provider-owned snapshot and atomic mutation assertions. No UI, agent, or network policy. */
public final class CalendarEventGuard {
 private static final String[] EVENT={"_id","calendar_id","title","description","eventLocation","dtstart","dtend","eventTimezone","allDay","rrule","rdate","exrule","exdate","original_id","original_sync_id","eventStatus","deleted","hasAlarm","hasAttendeeData","availability","accessLevel","organizer"};
 private static final String[] CALENDAR=CalendarSourceIdentity.fields();
 static final class Snapshot {
  final long id,calendarId; final ContentValues event,calendar; final String revision,sourceRevision;
  Snapshot(long id,long calendarId,ContentValues event,ContentValues calendar)throws Exception {
   this.id=id;this.calendarId=calendarId;this.event=event;this.calendar=calendar;
   sourceRevision=sourceDigest(calendar);
   StringBuilder canonical=new StringBuilder();append(canonical,EVENT,event);append(canonical,CALENDAR,calendar);
   byte[] bytes=MessageDigest.getInstance("SHA-256").digest(canonical.toString().getBytes(StandardCharsets.UTF_8));StringBuilder digest=new StringBuilder();for(byte b:bytes)digest.append(String.format(java.util.Locale.ROOT,"%02x",b&255));revision=digest.toString();
  }
  boolean direct(String accountName,String localName){return accountName.equals(calendar.getAsString("account_name"))&&CalendarContract.ACCOUNT_TYPE_LOCAL.equals(calendar.getAsString("account_type"))&&localName.equals(calendar.getAsString("name"))&&number(calendar,"calendar_access_level")>=CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR&&number(event,"allDay")==0&&number(event,"deleted")==0&&number(event,"hasAlarm")==0&&number(event,"hasAttendeeData")==0&&event.get("original_id")==null&&event.get("original_sync_id")==null&&empty(event,"rrule")&&empty(event,"rdate")&&empty(event,"exrule")&&empty(event,"exdate")&&event.get("dtend")!=null;}
  boolean visible(JSONObject expected){return expected!=null&&same(expected.optString("title",""),event,"title")&&same(expected.optString("body",""),event,"description")&&same(expected.optString("location",""),event,"eventLocation")&&expected.optLong("begin",-1)==number(event,"dtstart")&&expected.optLong("end",-1)==number(event,"dtend");}
  ArrayList<ContentProviderOperation> assertions(){
   ArrayList<ContentProviderOperation> operations=new ArrayList<>();
   operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId)).withValues(calendar).withExpectedCount(1).build());
   operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,id)).withValues(event).withExpectedCount(1).build());
   operations.add(ContentProviderOperation.newAssertQuery(CalendarContract.Attendees.CONTENT_URI).withSelection("event_id=?",new String[]{Long.toString(id)}).withExpectedCount(0).build());
   operations.add(ContentProviderOperation.newAssertQuery(CalendarContract.Reminders.CONTENT_URI).withSelection("event_id=?",new String[]{Long.toString(id)}).withExpectedCount(0).build());
   return operations;
  }
 }
 static String sourceRevision(ContentResolver resolver,long id,String account,String name)throws Exception {ContentValues values=read(resolver,ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,id),CALENDAR);if(values==null||!account.equals(values.getAsString("account_name"))||!CalendarContract.ACCOUNT_TYPE_LOCAL.equals(values.getAsString("account_type"))||!name.equals(values.getAsString("name"))||number(values,"calendar_access_level")<CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR)throw new IllegalStateException("Source unavailable");return sourceDigest(values);}
 static ContentProviderOperation sourceAssertion(ContentResolver resolver,long id,String expected)throws Exception{ContentValues values=read(resolver,ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,id),CALENDAR);if(values==null)throw new IllegalStateException();if(!expected.equals(sourceDigest(values)))throw new IllegalStateException("Source changed");return ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,id)).withValues(values).withExpectedCount(1).build();}
 private static String sourceDigest(ContentValues values)throws Exception {return CalendarSourceIdentity.digest(values);}
 private static String digest(String value)throws Exception{byte[] bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder result=new StringBuilder();for(byte b:bytes)result.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return result.toString();}
 private static void append(StringBuilder out,String[] fields,ContentValues values){for(String key:fields){Object value=values.get(key);out.append(key.length()).append(':').append(key).append(value==null?"N":"V"+value.toString().length()+":"+value.toString()).append(';');}}
 private static long number(ContentValues values,String key){Long value=values.getAsLong(key);return value==null?0:value;}
 private static boolean empty(ContentValues values,String key){String value=values.getAsString(key);return value==null||value.isEmpty();}
 private static boolean same(String value,ContentValues values,String key){String actual=values.getAsString(key);return value.equals(actual==null?"":actual);}
 private static ContentValues read(ContentResolver resolver,android.net.Uri uri,String[] fields){try(Cursor row=resolver.query(uri,fields,null,null,null)){if(row==null||!row.moveToFirst())return null;ContentValues values=new ContentValues();for(int i=0;i<fields.length;i++){if(row.isNull(i))values.putNull(fields[i]);else if(row.getType(i)==Cursor.FIELD_TYPE_INTEGER)values.put(fields[i],row.getLong(i));else values.put(fields[i],row.getString(i));}if(row.moveToNext())throw new IllegalStateException("Ambiguous event");return values;}}
 static Snapshot read(ContentResolver resolver,long id,long calendarId)throws Exception {
  if(id<=0||calendarId<=0)throw new IllegalArgumentException();ContentValues event=read(resolver,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,id),EVENT);
  if(event==null||number(event,"calendar_id")!=calendarId)return null;ContentValues calendar=read(resolver,ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId),CALENDAR);if(calendar==null)return null;
  return new Snapshot(id,calendarId,event,calendar);
 }
}
