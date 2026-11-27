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
  /** The calendar and event rows are unchanged. Attendee and reminder rows are not checked. */
  ArrayList<ContentProviderOperation> rowAssertions(){
   ArrayList<ContentProviderOperation> operations=new ArrayList<>();
   operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId)).withValues(calendar).withExpectedCount(1).build());
   operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,id)).withValues(event).withExpectedCount(1).build());
   return operations;
  }
  boolean writable(){return number(calendar,"calendar_access_level")>=CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR;}
  boolean repeating(){return !empty(event,"rrule")||!empty(event,"rdate")||!empty(event,"exrule")||!empty(event,"exdate")||event.get("original_id")!=null||!empty(event,"original_sync_id");}
  boolean deleted(){return number(event,"deleted")!=0;}
  ArrayList<ContentProviderOperation> assertions(){
   ArrayList<ContentProviderOperation> operations=rowAssertions();
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
 /** One selected row's recurrence family as the provider holds it. The provider supplies the scope
  * evidence and the bridge plans the scope; a dispatch writes only the change that family still admits,
  * asserting every family, attendee and reminder row in the same batch. */
 public static final class ScopedDeletion {
  static final int MAXIMUM_ROWS=2048,MAXIMUM_REVISION_INPUT=2*1024*1024;
  private static final String[] EVENT_FIELDS={"_id","calendar_id","title","description","eventLocation","dtstart","dtend","duration","eventTimezone","allDay","rrule","rdate","exrule","exdate","original_id","original_sync_id","originalInstanceTime","originalAllDay","eventStatus","deleted","hasAlarm","hasAttendeeData","availability","accessLevel","organizer","_sync_id","selfAttendeeStatus"};
  private static final String[] ATTENDEE_FIELDS={"_id","event_id","attendeeName","attendeeEmail","attendeeRelationship","attendeeType","attendeeStatus","attendeeIdentity","attendeeIdNamespace"};
  private static final String[] REMINDER_FIELDS={"_id","event_id","minutes","method"};
  public final long selectedId,parentId,calendarId;
  public final String revision,sourceRevision;
  private final ContentValues calendar,selected,parent;
  private final java.util.List<ContentValues> events,attendees,reminders;
  private final boolean bounded;
  private final String familyWhere;
  private final String[] familyArgs;
  private ScopedDeletion(ContentResolver resolver,long selectedId,long calendarId,ContentValues selected,ContentValues calendar)throws Exception{
   this.selectedId=selectedId;this.calendarId=calendarId;this.selected=selected;this.calendar=calendar;
   parentId=selected.get("original_id")==null?selectedId:number(selected,"original_id");
   parent=parentId==selectedId?selected:read(resolver,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,parentId),EVENT_FIELDS);
   familyWhere="calendar_id=? AND (_id=? OR original_id=?)";familyArgs=new String[]{Long.toString(calendarId),Long.toString(parentId),Long.toString(parentId)};
   events=rows(resolver,CalendarContract.Events.CONTENT_URI,EVENT_FIELDS,familyWhere,familyArgs);
   String children="event_id IN ("+ids(events)+")";
   attendees=rows(resolver,CalendarContract.Attendees.CONTENT_URI,ATTENDEE_FIELDS,children,null);
   reminders=rows(resolver,CalendarContract.Reminders.CONTENT_URI,REMINDER_FIELDS,children,null);
   sourceRevision=sourceDigest(calendar);
   StringBuilder canonical=new StringBuilder().append(selectedId).append(':').append(parentId).append(';');append(canonical,CALENDAR,calendar);
   for(ContentValues row:events)append(canonical,EVENT_FIELDS,row);for(ContentValues row:attendees)append(canonical,ATTENDEE_FIELDS,row);for(ContentValues row:reminders)append(canonical,REMINDER_FIELDS,row);
   bounded=events.size()<=MAXIMUM_ROWS&&attendees.size()<=MAXIMUM_ROWS&&reminders.size()<=MAXIMUM_ROWS&&canonical.length()<=MAXIMUM_REVISION_INPUT;
   revision=digest(canonical.toString());
  }
  /** The selected live row of this calendar and its family, or null when that row is gone or moved. */
  public static ScopedDeletion of(ContentResolver resolver,long selectedId,long calendarId)throws Exception{
   if(selectedId<=0||calendarId<=0)throw new IllegalArgumentException();
   ContentValues selected=read(resolver,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,selectedId),EVENT_FIELDS),calendar=read(resolver,ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId),CALENDAR);
   if(selected==null||calendar==null||number(selected,"calendar_id")!=calendarId||number(selected,"deleted")!=0)return null;
   return new ScopedDeletion(resolver,selectedId,calendarId,selected,calendar);
  }
  private static java.util.List<ContentValues> rows(ContentResolver resolver,android.net.Uri uri,String[] fields,String where,String[] args){
   java.util.List<ContentValues> result=new ArrayList<>();try(Cursor cursor=resolver.query(uri,fields,where,args,"_id ASC")){
    if(cursor==null)throw new IllegalStateException("Provider snapshot unavailable");while(result.size()<=MAXIMUM_ROWS&&cursor.moveToNext()){
     ContentValues row=new ContentValues();
     for(int i=0;i<fields.length;i++){if(cursor.isNull(i))row.putNull(fields[i]);else if(cursor.getType(i)==Cursor.FIELD_TYPE_INTEGER)row.put(fields[i],cursor.getLong(i));else row.put(fields[i],cursor.getString(i));}result.add(row);
    }
   }return result;
  }
  private static String ids(java.util.List<ContentValues> rows){StringBuilder ids=new StringBuilder();for(ContentValues row:rows){if(ids.length()>0)ids.append(',');ids.append(number(row,"_id"));}return ids.toString();}
  private static String text(ContentValues row,String key){String value=row.getAsString(key);return value==null?"":value;}
  private static boolean cancelled(ContentValues row){return number(row,"eventStatus")==CalendarContract.Events.STATUS_CANCELED;}
  private boolean parentLive(){return parent!=null&&number(parent,"calendar_id")==calendarId&&number(parent,"deleted")==0;}
  private ContentValues shape(){return parentLive()?parent:selected;}
  private boolean exceptionRow(){return parentId!=selectedId;}
  private boolean ruled(){return !empty(shape(),"rrule");}
  private String sync(){return !empty(shape(),"_sync_id")?"SyncedSeries":CalendarContract.ACCOUNT_TYPE_LOCAL.equals(calendar.getAsString("account_type"))?"LocalUnsynced":"RemoteUnsynced";}
  private long exceptionOriginal(){return exceptionRow()&&selected.get("originalInstanceTime")!=null?number(selected,"originalInstanceTime"):-1;}
  private java.util.List<ContentValues> exceptionsAt(long start){java.util.List<ContentValues> found=new ArrayList<>();for(ContentValues row:events)if(number(row,"_id")!=parentId&&number(row,"original_id")==parentId&&row.get("originalInstanceTime")!=null&&number(row,"originalInstanceTime")==start&&number(row,"deleted")==0)found.add(row);return found;}
  private String liveException(long start){
   java.util.List<ContentValues> found=exceptionsAt(start);
   if(found.isEmpty())return "NoLiveException";
   if(found.size()==1&&number(found.get(0),"_id")==selectedId)return cancelled(found.get(0))?"CancelledSelection":"SelectedException";
   return "OtherException";
  }
  public boolean writable(){return number(calendar,"calendar_access_level")>=CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR;}
  public String recurrence(){return ruled()?"rule":!empty(shape(),"rdate")?"date-list":"one-off";}
  public boolean matches(JSONObject expected){return expected.optString("title","").equals(text(selected,"title"))&&expected.optString("body","").equals(text(selected,"description"))&&expected.optString("location","").equals(text(selected,"eventLocation"));}
  private static int instances(ContentResolver resolver,long begin,long end,String where,String[] args){
   android.net.Uri.Builder range=CalendarContract.Instances.CONTENT_URI.buildUpon();ContentUris.appendId(range,begin);ContentUris.appendId(range,end);
   int count=0;try(Cursor row=resolver.query(range.build(),new String[]{CalendarContract.Instances.EVENT_ID},where,args,null)){if(row==null)throw new IllegalStateException("Provider instances unavailable");while(count<2&&row.moveToNext())count++;}return count;
  }
  /** Scope evidence for the instance the owner selected at begin through end. */
  public JSONObject evidence(ContentResolver resolver,long begin,long end)throws Exception{
   boolean others=false;for(ContentValues row:events)others|=number(row,"_id")!=parentId&&number(row,"_id")!=selectedId;
   int selection=begin<0||end<=begin?0:instances(resolver,begin,end,"event_id=? AND begin=? AND end=?",new String[]{Long.toString(selectedId),Long.toString(begin),Long.toString(end)});
   return new JSONObject().put("selectedRow",exceptionRow()?"ExceptionRow":"ParentRow").put("sync",sync()).put("sourceCurrent",parentLive()).put("bounded",bounded).put("otherExceptions",others)
    .put("liveException",liveException(exceptionRow()?exceptionOriginal():begin)).put("instances",selection).put("begin",begin).put("finish",end).put("exceptionOriginal",exceptionOriginal());
  }
  private String excludedDates(long start){String date=java.time.format.DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss'Z'",java.util.Locale.ROOT).withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.ofEpochMilli(start));return empty(parent,"exdate")?date:parent.getAsString("exdate")+"\n"+date;}
  private ContentValues exclusionUpdate(long start){
   ContentValues values=new ContentValues();
   for(String field:new String[]{"dtstart","dtend","allDay"}){if(parent.get(field)==null)values.putNull(field);else values.put(field,parent.getAsLong(field));}
   for(String field:new String[]{"duration","eventTimezone","rrule","rdate","exrule"}){if(parent.get(field)==null)values.putNull(field);else values.put(field,parent.getAsString(field));}
   values.put("exdate",excludedDates(start));return values;
  }
  private ContentProviderOperation write(String change,long start){
   if(!writable()||!parentLive()||!bounded)return null;
   ContentValues cancel=new ContentValues();cancel.put(CalendarContract.Events.STATUS,CalendarContract.Events.STATUS_CANCELED);
   switch(change){
    case "DeleteRow":return start!=-1?null:ContentProviderOperation.newDelete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,parentId)).withExpectedCount(1).build();
    case "ExcludeOccurrence":return !"LocalUnsynced".equals(sync())||!ruled()||exceptionRow()||events.size()!=1||start<0||start%1000!=0?null:ContentProviderOperation.newUpdate(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,parentId)).withValues(exclusionUpdate(start)).withExpectedCount(1).build();
    case "CancelOccurrence":return !"SyncedSeries".equals(sync())||!ruled()||!exceptionRow()||exceptionOriginal()!=start||!"SelectedException".equals(liveException(start))?null:ContentProviderOperation.newUpdate(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,selectedId)).withValues(cancel).withExpectedCount(1).build();
    case "InsertCancelledOccurrence":cancel.put(CalendarContract.Events.ORIGINAL_INSTANCE_TIME,start);return !"SyncedSeries".equals(sync())||!ruled()||exceptionRow()||start<0||!exceptionsAt(start).isEmpty()?null:ContentProviderOperation.newInsert(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_EXCEPTION_URI,parentId)).withValues(cancel).build();
    default:return null;
   }
  }
  /** The family assertions and then the one change, or null when this family no longer admits it. Never a retry API. */
  public ArrayList<ContentProviderOperation> batch(String change,long start){
   ContentProviderOperation write=write(change,start);if(write==null)return null;
   ArrayList<ContentProviderOperation> operations=new ArrayList<>();operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId)).withValues(calendar).withExpectedCount(1).build());
   addAssertions(operations,CalendarContract.Events.CONTENT_URI,events,familyWhere,familyArgs);
   String where="event_id IN ("+ids(events)+")";addAssertions(operations,CalendarContract.Attendees.CONTENT_URI,attendees,where,null);addAssertions(operations,CalendarContract.Reminders.CONTENT_URI,reminders,where,null);
   operations.add(write);return operations;
  }
  private boolean instanceAt(ContentResolver resolver,long at){return instances(resolver,at,at+1,"(event_id=? OR event_id=?) AND begin=?",new String[]{Long.toString(parentId),Long.toString(selectedId),Long.toString(at)})>0;}
  /** Local-provider evidence of what the change left; it does not claim a remote organizer accepted it. */
  public JSONObject readback(ContentResolver resolver,String change,long start)throws Exception{
   ContentValues after=read(resolver,ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,parentId),EVENT_FIELDS);
   boolean live=after!=null&&number(after,"deleted")==0,occurrence=!"DeleteRow".equals(change);
   int cancelledAt=0;if(occurrence)for(ContentValues row:rows(resolver,CalendarContract.Events.CONTENT_URI,EVENT_FIELDS,"original_id=? AND originalInstanceTime=? AND deleted=0",new String[]{Long.toString(parentId),Long.toString(start)}))if(cancelled(row))cancelledAt++;
   boolean remains=occurrence?instanceAt(resolver,start)||exceptionRow()&&instanceAt(resolver,number(selected,"dtstart")):live;
   return new JSONObject().put("parentAfter",live?"ParentLive":"ParentGone").put("fieldsMatch",false).put("exclusionExact","ExcludeOccurrence".equals(change)&&live&&excludedDates(start).equals(after.getAsString("exdate")))
    .put("cancelledAtStart",cancelledAt).put("instanceRemains",remains);
  }
  private static void addAssertions(ArrayList<ContentProviderOperation> operations,android.net.Uri uri,java.util.List<ContentValues> rows,String where,String[] args){
   operations.add(ContentProviderOperation.newAssertQuery(uri).withSelection(where,args).withExpectedCount(rows.size()).build());
   for(ContentValues row:rows)operations.add(ContentProviderOperation.newAssertQuery(ContentUris.withAppendedId(uri,number(row,"_id"))).withValues(row).withExpectedCount(1).build());
  }
 }

}
