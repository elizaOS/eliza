package ai.eliza.plugins.calendar.read;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;

/** Selected provider-query boundary. Caller owns authorization and permission checks. */
public final class SelectedCalendarReader {
 private SelectedCalendarReader() {}
 public static org.json.JSONArray read(ContentResolver resolver,org.json.JSONArray selected,String start,String finish,Integer maximum)throws Exception {
  return read(resolver,selected,start,finish,maximum,null,null);
 }
 /** Owner-day all-day membership follows civil dates, while timed events retain instant overlap. */
 public static org.json.JSONArray readOwnerDay(ContentResolver resolver,org.json.JSONArray selected,String start,String finish,Integer maximum,String startDate,String endDateExclusive)throws Exception {
  org.json.JSONArray identities=new org.json.JSONArray(selected.toString()),ids=new org.json.JSONArray();for(int i=0;i<identities.length();i++)ids.put(identities.getJSONObject(i).getString("id"));
  assertSourceIdentities(resolver,identities);
  java.time.LocalDate a=java.time.LocalDate.parse(startDate),b=java.time.LocalDate.parse(endDateExclusive);
  if(!a.toString().equals(startDate)||!b.toString().equals(endDateExclusive)||!b.isAfter(a)||java.time.temporal.ChronoUnit.DAYS.between(a,b)>7)throw new IllegalArgumentException();
  org.json.JSONArray result=read(resolver,ids,start,finish,maximum,a.atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli(),b.atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli());
  assertSourceIdentities(resolver,identities);return result;
 }
 /** Fixed foreground discovery: caller captures native time/zone and reviews the resulting single record. */
 public static org.json.JSONObject next(ContentResolver resolver,org.json.JSONArray sources,long now,java.time.ZoneId zone)throws Exception {
  if(now<0||sources==null||sources.length()>16)throw new IllegalArgumentException();
  assertSourceIdentities(resolver,sources);
  java.time.LocalDate day=java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate(),last=day.plusDays(30);
  java.time.format.DateTimeFormatter utc=new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter();
  org.json.JSONObject best=null;long bestStart=Long.MAX_VALUE;java.util.Set<String> seen=new java.util.HashSet<>();
  for(java.time.LocalDate first=day;first.isBefore(last)&&sources.length()>0;first=first.plusDays(6)){
   java.time.LocalDate end=first.plusDays(6).isAfter(last)?last:first.plusDays(6);
   String start=utc.format(first.equals(day)?java.time.Instant.ofEpochMilli(now):first.atStartOfDay(zone).toInstant()),finish=utc.format(end.atStartOfDay(zone).toInstant());
   org.json.JSONArray rows=readOwnerDay(resolver,sources,start,finish,200,first.toString(),end.toString());
   for(int i=0;i<rows.length();i++){
    org.json.JSONObject row=rows.getJSONObject(i);if(!seen.add(row.getString("calendarId")+":"+row.getString("id")+":"+row.getString("start")+":"+row.getString("end")))continue;if(seen.size()>200)throw new IllegalStateException("Discovery exceeds reviewed count");
    boolean allDay=row.getBoolean("allDay");long begin=java.time.Instant.parse(row.getString("start")).toEpochMilli();
    if(allDay&&(begin%86400000!=0||java.time.Instant.parse(row.getString("end")).toEpochMilli()%86400000!=0||java.time.Instant.parse(row.getString("end")).toEpochMilli()<=begin))throw new IllegalStateException("Invalid all-day civil interval");
    if(allDay)begin=java.time.Instant.ofEpochMilli(begin).atZone(java.time.ZoneOffset.UTC).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli();
    else if(begin<now)continue; // A past timed start is not the next upcoming event.
    if(begin<bestStart||(begin==bestStart&&row.getString("id").compareTo(best.getString("eventId"))<0)){
     String revision=null;for(int j=0;j<sources.length();j++)if(sources.getJSONObject(j).getString("id").equals(row.getString("calendarId")))revision=sources.getJSONObject(j).getString("revision");
     if(revision==null)throw new IllegalStateException();
     best=new org.json.JSONObject().put("title",row.getString("title")).put("start",row.getString("start")).put("end",row.getString("end")).put("allDay",allDay).put("timing",allDay&&begin<now?"ongoing":"upcoming").put("timeZone",zone.getId()).put("sourceId",row.getString("calendarId")).put("sourceRevision",revision).put("eventId",row.getString("id"));bestStart=begin;
    }
   }
  }
  assertSourceIdentities(resolver,sources);
  return new org.json.JSONObject().put("version",1).put("kind","calendar_read_next").put("window",new org.json.JSONObject().put("start",utc.format(java.time.Instant.ofEpochMilli(now))).put("end",utc.format(last.atStartOfDay(zone).toInstant())).put("timeZone",zone.getId())).put("event",best==null?org.json.JSONObject.NULL:best);
 }
 public static void assertSourceIdentities(ContentResolver resolver,org.json.JSONArray selected)throws Exception {
  if(selected.length()>16)throw new IllegalArgumentException();
  for(int i=0;i<selected.length();i++){org.json.JSONObject source=selected.getJSONObject(i);String revision=source.getString("revision");if(!revision.matches("[a-f0-9]{64}")||!revision.equals(CalendarSourceIdentity.read(resolver,Long.parseLong(source.getString("id"))).getString("sourceRevision")))throw new IllegalStateException("Selected calendar account changed");}
 }
 private static org.json.JSONArray read(ContentResolver resolver,org.json.JSONArray selected,String start,String finish,Integer maximum,Long civilBegin,Long civilEnd)throws Exception {

   if(selected==null||selected.length()<1||selected.length()>16||maximum==null||maximum<1||maximum>200||start==null||finish==null)throw new IllegalArgumentException();
   long begin=java.time.Instant.parse(start).toEpochMilli(),end=java.time.Instant.parse(finish).toEpochMilli();
   java.time.format.DateTimeFormatter format=new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter();
   if(!format.format(java.time.Instant.ofEpochMilli(begin)).equals(start)||!format.format(java.time.Instant.ofEpochMilli(end)).equals(finish)||end<=begin||end-begin>7L*86400000)throw new IllegalArgumentException();
   java.util.LinkedHashSet<String> ids=new java.util.LinkedHashSet<>();for(int i=0;i<selected.length();i++){String id=selected.getString(i);if(!id.matches("[1-9][0-9]{0,18}")||Long.parseLong(id)<=0||!ids.add(id))throw new IllegalArgumentException();}
   String[] arguments=ids.toArray(new String[0]);String placeholders=String.join(",",java.util.Collections.nCopies(ids.size(),"?"));
   java.util.Set<String> found=new java.util.HashSet<>();try(Cursor rows=resolver.query(CalendarContract.Calendars.CONTENT_URI,new String[]{CalendarContract.Calendars._ID},CalendarContract.Calendars._ID+" IN ("+placeholders+")",arguments,null)){if(rows==null)throw new IllegalStateException();while(rows.moveToNext())found.add(Long.toString(rows.getLong(0)));}if(!found.equals(ids))throw new IllegalStateException();
   Uri.Builder uri=CalendarContract.Instances.CONTENT_URI.buildUpon();ContentUris.appendId(uri,civilBegin==null?begin:Math.min(begin,civilBegin));ContentUris.appendId(uri,civilEnd==null?end:Math.max(end,civilEnd));
   // Selection is enforced in the provider query. Never read other calendars and filter later.
   String selection=CalendarContract.Instances.CALENDAR_ID+" IN ("+placeholders+") AND "+CalendarContract.Events.DELETED+"=0";
   if(civilBegin!=null){
    // Provider query excludes adjacent all-day dates before any content leaves the reader.
    selection+=" AND (("+CalendarContract.Instances.ALL_DAY+"=0 AND "+overlap(begin,end)+") OR ("+CalendarContract.Instances.ALL_DAY+"=1 AND "+overlap(civilBegin,civilEnd)+"))";
   }
   String[] projection={CalendarContract.Instances.EVENT_ID,CalendarContract.Instances.CALENDAR_ID,CalendarContract.Instances.TITLE,CalendarContract.Instances.BEGIN,CalendarContract.Instances.END,CalendarContract.Instances.ALL_DAY};
   org.json.JSONArray events=new org.json.JSONArray();try(Cursor rows=resolver.query(uri.build(),projection,selection,arguments,CalendarContract.Instances.BEGIN+" ASC, "+CalendarContract.Instances.EVENT_ID+" ASC")){
    if(rows==null)throw new IllegalStateException();while(rows.moveToNext()){
     long a=rows.getLong(3),b=rows.getLong(4);boolean allDay=rows.getInt(5)!=0;long rangeBegin=allDay&&civilBegin!=null?civilBegin:begin,rangeEnd=allDay&&civilEnd!=null?civilEnd:end;if(b<a)throw new IllegalStateException();if(a>=rangeEnd||(a==b?a<rangeBegin:b<=rangeBegin))continue;
     if(events.length()>=maximum)throw new IllegalStateException("Range exceeds reviewed count");String title=rows.getString(2);if(title==null)title="";if(title.length()>1000||title.indexOf(0)>=0)throw new IllegalStateException();String calendarId=Long.toString(rows.getLong(1));if(!ids.contains(calendarId))throw new IllegalStateException();
     org.json.JSONObject row=new org.json.JSONObject();row.put("id",Long.toString(rows.getLong(0)));row.put("calendarId",calendarId);row.put("title",title);row.put("start",format.format(java.time.Instant.ofEpochMilli(a)));row.put("end",format.format(java.time.Instant.ofEpochMilli(b)));row.put("allDay",rows.getInt(5)!=0);events.put(row);
     if(events.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>65536)throw new IllegalStateException("Range exceeds byte bound");
    }
   }
   return events;
 }
 private static String overlap(long begin,long end){return CalendarContract.Instances.BEGIN+"<"+end+" AND ("+CalendarContract.Instances.END+">"+begin+" OR ("+CalendarContract.Instances.END+"="+CalendarContract.Instances.BEGIN+" AND "+CalendarContract.Instances.BEGIN+">="+begin+"))";}
}
