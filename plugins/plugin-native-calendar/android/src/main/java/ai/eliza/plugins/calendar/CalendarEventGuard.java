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
 private static ContentValues read(ContentResolver resolver,android.net.Uri uri,String[] fields){try(Cursor row=resolver.query(uri,fields,null,null,null)){if(row==null)throw new IllegalStateException("Provider query unavailable");if(!row.moveToFirst())return null;ContentValues values=new ContentValues();for(int i=0;i<fields.length;i++){if(row.isNull(i))values.putNull(fields[i]);else if(row.getType(i)==Cursor.FIELD_TYPE_INTEGER)values.put(fields[i],row.getLong(i));else values.put(fields[i],row.getString(i));}if(row.moveToNext())throw new IllegalStateException("Ambiguous event");return values;}}
 static Snapshot read(ContentResolver resolver,long id,long calendarId)throws Exception {
  if(id<=0||calendarId<=0)throw new IllegalArgumentException();ContentValues event=read(resolver,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,id),EVENT);
  if(event==null||number(event,"calendar_id")!=calendarId)return null;ContentValues calendar=read(resolver,ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId),CALENDAR);if(calendar==null)return null;
  return new Snapshot(id,calendarId,event,calendar);
 }
 /** Provider snapshot used only for delayed reviewed deletion. All dependent rows are
  * asserted in the dispatch transaction; no caller is treated as a sync adapter. */
 public static final class ScopedDeletion {
  private static final String[] EVENT_FIELDS={"_id","calendar_id","title","description","eventLocation","dtstart","dtend","duration","eventTimezone","allDay","rrule","rdate","exrule","exdate","original_id","original_sync_id","originalInstanceTime","originalAllDay","eventStatus","deleted","hasAlarm","hasAttendeeData","availability","accessLevel","organizer","_sync_id","selfAttendeeStatus"};
  private static final String[] ATTENDEE_FIELDS={"_id","event_id","attendeeName","attendeeEmail","attendeeRelationship","attendeeType","attendeeStatus","attendeeIdentity","attendeeIdNamespace"};
  private static final String[] REMINDER_FIELDS={"_id","event_id","minutes","method"};
  public final long eventId,calendarId,selectedEventId,originalInstanceTime,begin,end;
  public final String scope,revision,sourceRevision;
  public final JSONObject fields;
  private final ContentValues calendar,parent;
  private final java.util.List<ContentValues> events,attendees,reminders;
  private final String familyWhere;
  private final String[] familyArgs;
  private ScopedDeletion(ContentResolver resolver,long id,long source,String scope,long instance,long selectedId,long selectedBegin,long selectedEnd)throws Exception{
   if(id<=0||source<=0||!(scope.equals("event")||scope.equals("occurrence")||scope.equals("series")))throw new IllegalArgumentException("Invalid deletion scope");
   this.eventId=id;this.calendarId=source;this.selectedEventId=selectedId;this.scope=scope;this.originalInstanceTime=instance;this.begin=selectedBegin;this.end=selectedEnd;
   parent=read(resolver,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,id),EVENT_FIELDS);
   calendar=read(resolver,ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,source),CALENDAR);
   if(parent==null||calendar==null||number(parent,"calendar_id")!=source||number(parent,"deleted")!=0||number(calendar,"calendar_access_level")<CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR)throw new IllegalStateException("Calendar source changed");
   boolean recurring=!empty(parent,"rrule")||!empty(parent,"rdate");
   if(parent.get("original_id")!=null||!empty(parent,"original_sync_id")||recurring==scope.equals("event")||scope.equals("occurrence")&&instance<0)throw new IllegalArgumentException("Calendar recurrence scope changed");
   // The public exception insertion API requires RRULE; reject unsupported RDATE-only
   // occurrence cancellation explicitly instead of silently deleting the series.
   if(scope.equals("occurrence")&&empty(parent,"rrule"))throw new UnsupportedOperationException("This recurrence needs external Calendar review");
   if(scope.equals("occurrence")&&!local()&&empty(parent,"_sync_id"))throw new UnsupportedOperationException("This unsynced calendar event needs external Calendar review");
   familyWhere="calendar_id=? AND (_id=? OR original_id=?)";familyArgs=new String[]{Long.toString(source),Long.toString(id),Long.toString(id)};
   events=rows(resolver,CalendarContract.Events.CONTENT_URI,EVENT_FIELDS,familyWhere,familyArgs,2048);
   if(scope.equals("occurrence")&&localExclusion()&&(events.size()!=1||selectedId!=id||instance%1000!=0))throw new UnsupportedOperationException("This local recurrence needs external Calendar review");
   StringBuilder ids=new StringBuilder();for(ContentValues event:events){if(ids.length()>0)ids.append(',');ids.append(number(event,"_id"));}
   String children="event_id IN ("+ids+")";
   attendees=rows(resolver,CalendarContract.Attendees.CONTENT_URI,ATTENDEE_FIELDS,children,null,2048);
   reminders=rows(resolver,CalendarContract.Reminders.CONTENT_URI,REMINDER_FIELDS,children,null,2048);
   ContentValues selected=null;for(ContentValues row:events)if(number(row,"_id")==selectedId)selected=row;
   if(selected==null||number(selected,"deleted")!=0)throw new IllegalStateException("Selected event changed");
   if(scope.equals("occurrence")){
    int matches=0;for(ContentValues event:events)if(number(event,"original_id")==id&&number(event,"originalInstanceTime")==instance&&number(event,"deleted")==0){if(number(event,"_id")!=selectedId)throw new IllegalStateException("Selected exception changed");matches++;}
    if(matches>1||number(selected,"eventStatus")==CalendarContract.Events.STATUS_CANCELED)throw new IllegalStateException("Ambiguous or cancelled recurrence exception");
   }
   if(selectedBegin<0||selectedEnd<=selectedBegin)throw new IllegalArgumentException("Invalid selected occurrence");
   android.net.Uri.Builder range=CalendarContract.Instances.CONTENT_URI.buildUpon();ContentUris.appendId(range,selectedBegin);ContentUris.appendId(range,selectedEnd);
   String[] projection={CalendarContract.Instances.EVENT_ID,CalendarContract.Instances.BEGIN,CalendarContract.Instances.END};
   try(Cursor row=resolver.query(range.build(),projection,"event_id=? AND begin=? AND end=?",new String[]{Long.toString(number(selected,"_id")),Long.toString(selectedBegin),Long.toString(selectedEnd)},null)){
    if(row==null||!row.moveToFirst()||row.moveToNext())throw new IllegalStateException("Selected occurrence changed");
   }
   if(scope.equals("occurrence")&&selectedId==id&&selectedBegin!=instance)throw new IllegalStateException("Original occurrence identity changed");
   String zone=selected.getAsString("eventTimezone");if(zone==null||zone.isEmpty())zone="UTC";
   fields=new JSONObject().put("title",text(selected,"title")).put("description",text(selected,"description")).put("location",text(selected,"eventLocation")).put("start",instant(selectedBegin)).put("end",instant(selectedEnd)).put("timeZone",zone);
   sourceRevision=sourceDigest(calendar);
   StringBuilder canonical=new StringBuilder();canonical.append(scope).append(':').append(id).append(':').append(instance).append(':').append(selectedId).append(':').append(selectedBegin).append(':').append(selectedEnd).append(';');append(canonical,CALENDAR,calendar);
   for(ContentValues row:events)append(canonical,EVENT_FIELDS,row);for(ContentValues row:attendees)append(canonical,ATTENDEE_FIELDS,row);for(ContentValues row:reminders)append(canonical,REMINDER_FIELDS,row);
   if(canonical.length()>2*1024*1024)throw new IllegalStateException("Calendar snapshot exceeds bounded review");revision=digest(canonical.toString());
  }
  private static String instant(long value){return java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd\'T\'HH:mm:ss.SSS\'Z\'",java.util.Locale.ROOT).withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.ofEpochMilli(value));}
  private static String text(ContentValues row,String key){String value=row.getAsString(key);return value==null?"":value;}
  private static java.util.List<ContentValues> rows(ContentResolver resolver,android.net.Uri uri,String[] fields,String where,String[] args,int maximum){
   java.util.List<ContentValues> result=new ArrayList<>();try(Cursor cursor=resolver.query(uri,fields,where,args,"_id ASC")){
    if(cursor==null)throw new IllegalStateException("Provider snapshot unavailable");while(cursor.moveToNext()){
     if(result.size()>=maximum)throw new IllegalStateException("Provider snapshot exceeds bounded review");ContentValues row=new ContentValues();
     for(int i=0;i<fields.length;i++){if(cursor.isNull(i))row.putNull(fields[i]);else if(cursor.getType(i)==Cursor.FIELD_TYPE_INTEGER)row.put(fields[i],cursor.getLong(i));else row.put(fields[i],cursor.getString(i));}result.add(row);
    }
   }return result;
  }
  public boolean matchesVisible(JSONObject expected){return expected!=null&&expected.optString("title","").equals(fields.optString("title"))&&expected.optString("body","").equals(fields.optString("description"))&&expected.optString("location","").equals(fields.optString("location"))&&expected.optLong("begin",-1)==begin&&expected.optLong("end",-1)==end;}
  public String account(){return text(calendar,"account_name");}
  public boolean local(){return CalendarContract.ACCOUNT_TYPE_LOCAL.equals(calendar.getAsString("account_type"));}
  public String organizer(){return text(parent,"organizer");}
  public int attendeeCount(){return attendees.size();}
  private boolean localExclusion(){return local()&&empty(parent,"_sync_id");}
  private String excludedDates(){String date=java.time.format.DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss'Z'",java.util.Locale.ROOT).withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.ofEpochMilli(originalInstanceTime));return empty(parent,"exdate")?date:parent.getAsString("exdate")+"\n"+date;}
  private ContentValues exclusionUpdate(){
   ContentValues values=new ContentValues();
   for(String field:new String[]{"dtstart","dtend","allDay"}){if(parent.get(field)==null)values.putNull(field);else values.put(field,parent.getAsLong(field));}
   for(String field:new String[]{"duration","eventTimezone","rrule","rdate","exrule"}){if(parent.get(field)==null)values.putNull(field);else values.put(field,parent.getAsString(field));}
   values.put("exdate",excludedDates());return values;
  }
  public ArrayList<ContentProviderOperation> assertions(){
   ArrayList<ContentProviderOperation> operations=new ArrayList<>();operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId)).withValues(calendar).withExpectedCount(1).build());
   addAssertions(operations,CalendarContract.Events.CONTENT_URI,events,familyWhere,familyArgs);
   StringBuilder ids=new StringBuilder();for(ContentValues event:events){if(ids.length()>0)ids.append(',');ids.append(number(event,"_id"));}
   String where="event_id IN ("+ids+")";addAssertions(operations,CalendarContract.Attendees.CONTENT_URI,attendees,where,null);addAssertions(operations,CalendarContract.Reminders.CONTENT_URI,reminders,where,null);return operations;
  }
  /** Caller must persist its dispatch claim first. This method is never a retry API. */
  public void dispatch(ContentResolver resolver)throws Exception{
   ArrayList<ContentProviderOperation> operations=assertions();
   if(!scope.equals("occurrence"))operations.add(ContentProviderOperation.newDelete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,eventId)).withExpectedCount(1).build());
   else if(localExclusion()){
    // AOSP's unsynced-exception cache expansion omits the recurrence family.
    // For an unmodified local series, exclude this exact original UTC occurrence
    // on the parent. Supply its unchanged recurrence fields so expansion retains
    // duration and every other occurrence. Existing exceptions require editor review.
    operations.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,eventId)).withValues(exclusionUpdate()).withExpectedCount(1).build());
   }else{
    ContentValues exception=null;for(ContentValues event:events)if(number(event,"original_id")==eventId&&number(event,"originalInstanceTime")==originalInstanceTime&&number(event,"deleted")==0)exception=event;
    ContentValues cancelled=new ContentValues();cancelled.put(CalendarContract.Events.STATUS,CalendarContract.Events.STATUS_CANCELED);
    if(exception!=null)operations.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,number(exception,"_id"))).withValues(cancelled).withExpectedCount(1).build());
    else{cancelled.put(CalendarContract.Events.ORIGINAL_INSTANCE_TIME,originalInstanceTime);operations.add(ContentProviderOperation.newInsert(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_EXCEPTION_URI,eventId)).withValues(cancelled).build());}
   }
   resolver.applyBatch(CalendarContract.AUTHORITY,operations);
  }
  /** Local-provider evidence only; it does not claim a remote organizer accepted a change. */
  public boolean deletionVerified(ContentResolver resolver)throws Exception{
   ContentValues current=read(resolver,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,eventId),EVENT_FIELDS);
   if(!scope.equals("occurrence"))return current==null||number(current,"deleted")==1;
   if(current==null||number(current,"deleted")!=0||number(current,"calendar_id")!=calendarId)return false;
   if(localExclusion()){
    if(!excludedDates().equals(current.getAsString("exdate")))return false;
    android.net.Uri.Builder range=CalendarContract.Instances.CONTENT_URI.buildUpon();ContentUris.appendId(range,begin);ContentUris.appendId(range,end);
    try(Cursor row=resolver.query(range.build(),new String[]{CalendarContract.Instances.EVENT_ID},"event_id=? AND begin=? AND end=?",new String[]{Long.toString(eventId),Long.toString(begin),Long.toString(end)},null)){return row!=null&&!row.moveToFirst();}
   }
   java.util.List<ContentValues> exceptions=rows(resolver,CalendarContract.Events.CONTENT_URI,EVENT_FIELDS,"original_id=? AND originalInstanceTime=? AND deleted=0",new String[]{Long.toString(eventId),Long.toString(originalInstanceTime)},2);
   if(exceptions.size()!=1||number(exceptions.get(0),"eventStatus")!=CalendarContract.Events.STATUS_CANCELED)return false;
   android.net.Uri.Builder range=CalendarContract.Instances.CONTENT_URI.buildUpon();ContentUris.appendId(range,begin);ContentUris.appendId(range,end);
   try(Cursor row=resolver.query(range.build(),new String[]{CalendarContract.Instances.EVENT_ID},"(event_id=? OR event_id=?) AND begin=?",new String[]{Long.toString(eventId),Long.toString(number(exceptions.get(0),"_id")),Long.toString(begin)},null)){return row!=null&&!row.moveToFirst();}
  }
  private static void addAssertions(ArrayList<ContentProviderOperation> operations,android.net.Uri uri,java.util.List<ContentValues> rows,String where,String[] args){
   operations.add(ContentProviderOperation.newAssertQuery(uri).withSelection(where,args).withExpectedCount(rows.size()).build());
   for(ContentValues row:rows)operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(uri,number(row,"_id"))).withValues(row).withExpectedCount(1).build());
  }
 }
 public static ScopedDeletion selectScopedDeletion(ContentResolver resolver,long selectedId,long calendarId,String requestedScope,long begin,long end)throws Exception{
  ContentValues selected=read(resolver,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,selectedId),ScopedDeletion.EVENT_FIELDS);
  if(selected==null||number(selected,"calendar_id")!=calendarId||number(selected,"deleted")!=0)throw new IllegalStateException("Selected event changed");
  long parentId=selected.get("original_id")==null?selectedId:number(selected,"original_id");
  boolean recurring=parentId!=selectedId||!empty(selected,"rrule")||!empty(selected,"rdate");
  String scope=requestedScope==null?(recurring?"occurrence":"event"):requestedScope;
  long instance=scope.equals("occurrence")?(parentId==selectedId?begin:number(selected,"originalInstanceTime")):-1;
  return new ScopedDeletion(resolver,parentId,calendarId,scope,instance,selectedId,begin,end);
 }
 public static ScopedDeletion readScopedDeletion(ContentResolver resolver,long eventId,long calendarId,String scope,long originalInstanceTime,long selectedEventId,long begin,long end)throws Exception{return new ScopedDeletion(resolver,eventId,calendarId,scope,originalInstanceTime,selectedEventId,begin,end);}

}
