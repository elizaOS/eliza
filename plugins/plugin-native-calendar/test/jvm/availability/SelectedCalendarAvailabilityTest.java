package ai.eliza.plugins.calendar.read;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs SelectedCalendarReader.readAvailability and availabilitySources on the JVM. The provider is a stand-in: the
 * reader's exact projection, selection, arguments and sort order are executed by the sqlite3
 * command-line shell over tables that use CalendarProvider's column names and hold titles,
 * descriptions, locations and calendars the owner never chose. This checks the reader's SQL
 * and row handling. It is not Android CalendarProvider, a permission check or a device run.
 */
public final class SelectedCalendarAvailabilityTest {
 private static final String UNIT="\u001f",RECORD="\u001e";
 private static final long HOUR=3600000L,DAY=86400000L;
 private static final DateTimeFormatter INSTANT=new DateTimeFormatterBuilder().appendInstant(3).toFormatter();
 private static final String[] EXPECTED_PROJECTION={"calendar_id","begin","end","all_day","availability","eventStatus","selfAttendeeStatus"};
 interface Work {void run()throws Exception;}
 static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
 static void same(Object expected,Object actual,String message){if(!String.valueOf(expected).equals(String.valueOf(actual)))throw new AssertionError(message+"\n expected "+expected+"\n actual   "+actual);}
 static void rejects(Class<? extends Exception> type,Work work)throws Exception{
  try{work.run();}catch(Exception thrown){if(type.isInstance(thrown))return;throw new AssertionError("Expected "+type.getSimpleName()+" but got "+thrown);}
  throw new AssertionError("Expected "+type.getSimpleName());
 }
 static String iso(long at){return INSTANT.format(Instant.ofEpochMilli(at));}
 static String sqlite(String database,String sql){
  try{
   Process process=new ProcessBuilder("sqlite3","-batch","-noheader","-separator",UNIT,"-newline",RECORD,database,sql).redirectErrorStream(true).start();
   String output=new String(process.getInputStream().readAllBytes(),StandardCharsets.UTF_8);
   if(process.waitFor()!=0)throw new IllegalStateException("sqlite3 rejected the provider query: "+output+"\n"+sql);
   return output;
  }catch(RuntimeException error){throw error;}catch(Exception error){throw new IllegalStateException(error);}
 }
 /** One result set. Every value arrives with its SQLite storage class, as a provider cursor reports it. */
 static final class Rows implements Cursor {
  private final List<String[]> rows;private int at=-1;
  Rows(List<String[]> rows){this.rows=rows;}
  private String value(int column){return rows.get(at)[column*2];}
  private String type(int column){return rows.get(at)[column*2+1];}
  public boolean moveToFirst(){at=0;return !rows.isEmpty();}
  public boolean moveToNext(){return ++at<rows.size();}
  public boolean isNull(int column){return type(column).equals("null");}
  public int getType(int column){return type(column).equals("integer")?FIELD_TYPE_INTEGER:3;}
  public long getLong(int column){return Long.parseLong(value(column));}
  public int getInt(int column){return Integer.parseInt(value(column));}
  public String getString(int column){return isNull(column)?null:value(column);}
  public void close(){}
 }
 /** SQLite-backed stand-in for the Calendars and Instances provider URIs the reader uses. */
 static final class Provider extends ContentResolver {
  final String database;
  final List<String> instanceSelections=new ArrayList<>(),instanceUris=new ArrayList<>();
  final List<String[]> instanceArguments=new ArrayList<>();
  Runnable afterInstances;List<String[]> hostileRows;
  Provider(Path directory)throws Exception {
   database=directory.resolve("provider-"+System.nanoTime()+".db").toString();
   sqlite(database,"CREATE TABLE calendars(_id INTEGER PRIMARY KEY,account_name TEXT,account_type TEXT,name TEXT,calendar_displayName TEXT,calendar_access_level INTEGER,ownerAccount TEXT);"
    +"CREATE TABLE instances(calendar_id INTEGER,event_id INTEGER,title TEXT,description TEXT,eventLocation TEXT,\"begin\" INTEGER,\"end\" INTEGER,all_day INTEGER,availability INTEGER,eventStatus INTEGER,selfAttendeeStatus INTEGER,deleted INTEGER);");
  }
  /** Fixture writes are applied together before the next provider read. */
  private final StringBuilder pending=new StringBuilder();
  void write(String sql){pending.append(sql);}
  private void flush(){if(pending.length()>0){String sql=pending.toString();pending.setLength(0);sqlite(database,sql);}}
  void calendar(long id,String label,int access){
   write("INSERT INTO calendars VALUES("+id+",'"+label+"@account.example','com.example','"+label+"_CALENDAR_NAME','"+label+"_CALENDAR_NAME',"+access+",'"+label+"@owner.example');");
  }
  private long nextEvent=1;
  void event(long calendar,String title,long begin,long end,boolean allDay,Integer availability,Integer status,Integer self,boolean deleted){
   write("INSERT INTO instances VALUES("+calendar+","+(nextEvent++)+",'SECRET_"+title+"_TITLE','SECRET_DESCRIPTION','SECRET_LOCATION',"+begin+","+end+","+(allDay?1:0)+","
    +(availability==null?"NULL":availability.toString())+","+(status==null?"NULL":status.toString())+","+(self==null?"NULL":self.toString())+","+(deleted?1:0)+");");
  }
  @Override public Cursor query(Uri uri,String[] projection,String selection,String[] arguments,String sort){
   String[] path=uri.value.split("/");String table,scope;
   if(path[0].equals("calendars")&&path.length<=2){table="calendars";scope=path.length==2?"_id="+Long.parseLong(path[1]):"1";}
   else if(path[0].equals("instances")&&path.length==3){
    // CalendarProvider's own range clause for an Instances URI: begin<=rangeEnd AND end>=rangeBegin.
    table="instances";scope="\"begin\"<="+Long.parseLong(path[2])+" AND \"end\">="+Long.parseLong(path[1]);
    same(Arrays.toString(EXPECTED_PROJECTION),Arrays.toString(projection),"The reader projects times, all-day, availability and status only");
    instanceUris.add(uri.value);instanceSelections.add(selection);instanceArguments.add(arguments==null?new String[0]:arguments.clone());
   }else throw new AssertionError("Unexpected provider URI "+uri.value);
   StringBuilder columns=new StringBuilder();
   for(String column:projection){
    require(column.matches("[A-Za-z_]+"),"Projection is a plain column: "+column);
    // The reader must never ask for event content, whatever it then does with the row.
    require(!Arrays.asList("title","description","eventLocation","organizer","event_id","_id").contains(column)||table.equals("calendars"),"Event content column requested: "+column);
    if(columns.length()>0)columns.append(',');columns.append(column).append(",typeof(").append(column).append(')');
   }
   String bound="1";
   if(selection!=null){
    StringBuilder text=new StringBuilder();int used=0;
    for(char c:selection.toCharArray()){
     if(c!='?'){text.append(c);continue;}
     require(arguments!=null&&used<arguments.length&&arguments[used].matches("[0-9]{1,19}"),"Each placeholder binds one numeric argument");
     text.append(arguments[used++]);
    }
    require(used==(arguments==null?0:arguments.length),"Every argument is bound");bound=text.toString();
   }
   if(table.equals("instances")&&hostileRows!=null)return new Rows(hostileRows);
   flush();
   String output=sqlite(database,"SELECT "+columns+" FROM "+table+" WHERE ("+scope+") AND ("+bound+")"+(sort==null?"":" ORDER BY "+sort)+";");
   List<String[]> rows=new ArrayList<>();
   for(String record:output.split(RECORD,-1)){if(record.isEmpty())continue;String[] cells=record.split(UNIT,-1);require(cells.length==projection.length*2,"Complete provider row");rows.add(cells);}
   if(table.equals("instances")&&afterInstances!=null){Runnable hook=afterInstances;afterInstances=null;hook.run();}
   return new Rows(rows);
  }
 }
 static JSONArray chosen(Provider provider,long... ids)throws Exception {
  JSONArray selected=new JSONArray();
  for(long id:ids)selected.put(new JSONObject().put("id",Long.toString(id)).put("revision",CalendarSourceIdentity.read(provider,id).getString("sourceRevision")));
  return selected;
 }
 static JSONObject row(long start,long end,boolean allDay,String availability)throws Exception {
  return new JSONObject().put("start",iso(start)).put("end",iso(end)).put("allDay",allDay).put("availability",availability);
 }
 /** Exact rows, each with exactly the four shared fields, and no event or calendar content. */
 static void rows(JSONArray actual,JSONObject... expected)throws Exception {
  same(expected.length,actual.length(),"Row count in "+actual);
  for(int i=0;i<expected.length;i++){
   JSONObject got=actual.getJSONObject(i);same(4,got.length(),"Only start, end, allDay and availability are returned: "+got);
   for(String key:new String[]{"start","end","allDay","availability"})same(expected[i].get(key),got.get(key),key+" of row "+i+" in "+actual);
  }
  String text=actual.toString();
  for(String secret:new String[]{"SECRET","CALENDAR_NAME","example","title","description","location","calendar"})require(!text.contains(secret),"No event or calendar content: "+secret+" in "+text);
 }

 public static void main(String[] args)throws Exception {
  Path directory=Files.createTempDirectory("calendar-availability-reader-");
  try{
   // Zones on both sides of UTC, a half-hour offset, and the two extremes (UTC+14, UTC-11).
   for(String zoneName:new String[]{"America/New_York","Asia/Tokyo","Asia/Kolkata","Pacific/Kiritimati","Pacific/Pago_Pago"}){
    ZoneId zone=ZoneId.of(zoneName);LocalDate date=LocalDate.parse("2026-10-13");
    long dayStart=date.atStartOfDay(zone).toInstant().toEpochMilli(),dayEnd=date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli();
    Provider provider=new Provider(directory);
    provider.calendar(1,"WORK",700);provider.calendar(2,"UNRELATED",700);provider.calendar(3,"FREEBUSY",100);provider.calendar(4,"HIDDEN",0);
    provider.event(1,"BUSY",dayStart+9*HOUR,dayStart+10*HOUR,false,0,1,null,false);
    provider.event(1,"FREE",dayStart+11*HOUR,dayStart+12*HOUR,false,1,1,null,false);
    provider.event(1,"TENTATIVE",dayStart+13*HOUR,dayStart+14*HOUR,false,2,1,null,false);
    provider.event(1,"CANCELLED",dayStart+15*HOUR,dayStart+16*HOUR,false,0,2,null,false);
    provider.event(1,"DECLINED",dayStart+16*HOUR,dayStart+17*HOUR,false,0,1,2,false);
    provider.event(1,"DELETED",dayStart+17*HOUR,dayStart+18*HOUR,false,0,1,null,true);
    provider.event(1,"UNSET",dayStart+18*HOUR,dayStart+19*HOUR,false,null,null,null,false);
    provider.event(1,"INVITED",dayStart+19*HOUR,dayStart+20*HOUR,false,0,0,3,false);
    provider.event(1,"NEXT_DAY",dayEnd+2*HOUR,dayEnd+3*HOUR,false,0,1,null,false);
    provider.event(2,"PARTNER",dayStart+9*HOUR,dayStart+17*HOUR,false,0,1,null,false);
    provider.event(3,"SHARED",dayStart+20*HOUR,dayStart+21*HOUR,false,0,1,null,false);

    // Only the chosen calendar: provider availability is carried, cancelled, declined and deleted rows are not occurrences.
    JSONArray work=SelectedCalendarReader.readAvailability(provider,chosen(provider,1),iso(dayStart),iso(dayEnd),zone);
    rows(work,row(dayStart+9*HOUR,dayStart+10*HOUR,false,"busy"),row(dayStart+11*HOUR,dayStart+12*HOUR,false,"free"),row(dayStart+13*HOUR,dayStart+14*HOUR,false,"tentative"),
     row(dayStart+18*HOUR,dayStart+19*HOUR,false,"busy"),row(dayStart+19*HOUR,dayStart+20*HOUR,false,"busy"));
    same("[1]",Arrays.toString(provider.instanceArguments.get(0)),"Only the chosen calendar id is bound");
    require(provider.instanceSelections.get(0).startsWith("calendar_id IN (?) AND deleted=0 AND "),"Selection is enforced in the provider query: "+provider.instanceSelections.get(0));
    // A window covered only by an event marked free: the unrelated calendar's overlapping event is never read.
    JSONArray freeHour=SelectedCalendarReader.readAvailability(provider,chosen(provider,1),iso(dayStart+11*HOUR),iso(dayStart+12*HOUR),zone);
    rows(freeHour,row(dayStart+11*HOUR,dayStart+12*HOUR,false,"free"));
    // Choosing two calendars adds the second calendar's interval and nothing else.
    rows(SelectedCalendarReader.readAvailability(provider,chosen(provider,1,2),iso(dayStart),iso(dayEnd),zone),
     row(dayStart+9*HOUR,dayStart+10*HOUR,false,"busy"),row(dayStart+9*HOUR,dayStart+17*HOUR,false,"busy"),row(dayStart+11*HOUR,dayStart+12*HOUR,false,"free"),row(dayStart+13*HOUR,dayStart+14*HOUR,false,"tentative"),
     row(dayStart+18*HOUR,dayStart+19*HOUR,false,"busy"),row(dayStart+19*HOUR,dayStart+20*HOUR,false,"busy"));
    // A calendar shared at free/busy level is readable when chosen.
    rows(SelectedCalendarReader.readAvailability(provider,chosen(provider,3),iso(dayStart),iso(dayEnd),zone),row(dayStart+20*HOUR,dayStart+21*HOUR,false,"busy"));
    // Touching intervals do not overlap: an event ending at the window start or starting at its end is not read.
    rows(SelectedCalendarReader.readAvailability(provider,chosen(provider,1),iso(dayStart+10*HOUR),iso(dayStart+11*HOUR),zone));
    rows(SelectedCalendarReader.readAvailability(provider,chosen(provider,1),iso(dayStart+9*HOUR+1800000),iso(dayStart+9*HOUR+1800001),zone),row(dayStart+9*HOUR,dayStart+10*HOUR,false,"busy"));
    for(String[] bound:provider.instanceArguments)for(String id:bound)require(!id.equals("4"),"A calendar the owner did not choose is never bound");

    // All-day events are stored as UTC-midnight civil dates and block the owner's local date.
    long civil=date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
    Provider days=new Provider(directory);days.calendar(1,"HOME",700);days.calendar(2,"UNRELATED",700);
    days.event(1,"HOLIDAY",civil,civil+DAY,true,0,1,null,false);
    days.event(1,"BIRTHDAY",civil,civil+DAY,true,1,1,null,false);
    days.event(1,"LATER",civil+2*DAY,civil+3*DAY,true,0,1,null,false);
    days.event(2,"PARTNER_TRIP",civil-DAY,civil+2*DAY,true,0,1,null,false);
    JSONObject holiday=row(civil,civil+DAY,true,"busy"),birthday=row(civil,civil+DAY,true,"free");
    JSONArray firstHour=SelectedCalendarReader.readAvailability(days,chosen(days,1),iso(dayStart),iso(dayStart+HOUR),zone);
    rows(firstHour,holiday,birthday);
    JSONArray lastHour=SelectedCalendarReader.readAvailability(days,chosen(days,1),iso(dayEnd-HOUR),iso(dayEnd),zone);
    rows(lastHour,holiday,birthday);
    // The local hours just outside the date are free, even where the UTC date still matches.
    JSONArray before=SelectedCalendarReader.readAvailability(days,chosen(days,1),iso(dayStart-HOUR),iso(dayStart),zone);rows(before);
    JSONArray after=SelectedCalendarReader.readAvailability(days,chosen(days,1),iso(dayEnd),iso(dayEnd+HOUR),zone);rows(after);
    // The provider range covers both the instant window and the civil dates, so no all-day row is missed.
    String[] range=days.instanceUris.get(0).split("/");
    same(Math.min(dayStart,civil),Long.parseLong(range[1]),"Range begin");same(Math.max(dayStart+HOUR,civil+DAY),Long.parseLong(range[2]),"Range end");
   }

   ZoneId zone=ZoneId.of("America/New_York");LocalDate date=LocalDate.parse("2026-10-13");
   long dayStart=date.atStartOfDay(zone).toInstant().toEpochMilli(),dayEnd=date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli();
   String start=iso(dayStart),end=iso(dayEnd);

   // Sources: every calendar readable at free/busy level or above, and never one with no access.
   Provider provider=new Provider(directory);
   provider.calendar(1,"WORK",700);provider.calendar(2,"SHARED",100);provider.calendar(3,"HIDDEN",0);
   provider.event(1,"BUSY",dayStart+9*HOUR,dayStart+10*HOUR,false,0,1,null,false);
   JSONArray sources=SelectedCalendarReader.availabilitySources(provider);
   same(2,sources.length(),"Readable calendars");
   for(int i=0;i<sources.length();i++){
    JSONObject source=sources.getJSONObject(i);same(4,source.length(),"Source fields "+source);same(Long.toString(i+1),source.getString("id"),"Source id");
    require(source.getString("sourceRevision").matches("[a-f0-9]{64}")&&source.getString("name").endsWith("_CALENDAR_NAME")&&source.getString("account").endsWith("@account.example"),"Source identity "+source);
    same(CalendarSourceIdentity.read(provider,i+1).getString("sourceRevision"),source.getString("sourceRevision"),"The offered revision is the one the read asserts");
   }
   // A read is bound to the revisions the owner reviewed.
   JSONArray reviewed=chosen(provider,1);
   rows(SelectedCalendarReader.readAvailability(provider,reviewed,start,end,zone),row(dayStart+9*HOUR,dayStart+10*HOUR,false,"busy"));
   provider.write("UPDATE calendars SET name='RENAMED' WHERE _id=1;");
   int readsBefore=provider.instanceUris.size();
   rejects(SelectedCalendarReader.SourceChanged.class,()->SelectedCalendarReader.readAvailability(provider,reviewed,start,end,zone));
   same(readsBefore,provider.instanceUris.size(),"A changed calendar is refused before any event is read");
   JSONArray current=chosen(provider,1);
   provider.afterInstances=()->sqlite(provider.database,"UPDATE calendars SET account_name='moved@account.example' WHERE _id=1;");
   rejects(SelectedCalendarReader.SourceChanged.class,()->SelectedCalendarReader.readAvailability(provider,current,start,end,zone));
   rejects(SelectedCalendarReader.SourceChanged.class,()->SelectedCalendarReader.readAvailability(provider,new JSONArray().put(new JSONObject().put("id","987654321").put("revision",current.getJSONObject(0).getString("revision"))),start,end,zone));

   // Malformed selections and windows are refused before any provider read.
   JSONArray valid=chosen(provider,1);JSONObject one=valid.getJSONObject(0);String revision=one.getString("revision");
   int before=provider.instanceUris.size();
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,null,start,end,zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,new JSONArray(),start,end,zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,new JSONArray().put(one).put(one),start,end,zone));
   JSONArray seventeen=new JSONArray();for(int i=1;i<=17;i++)seventeen.put(new JSONObject().put("id",Integer.toString(i)).put("revision",revision));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,seventeen,start,end,zone));
   for(String id:new String[]{"0","01","-1","1 OR 1=1","1)","","abc"})
    rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,new JSONArray().put(new JSONObject().put("id",id).put("revision",revision)),start,end,zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,new JSONArray().put(new JSONObject().put("id","1").put("revision",revision.toUpperCase())),start,end,zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,new JSONArray().put(new JSONObject().put("id","1").put("revision",revision).put("title","x")),start,end,zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,valid,start,iso(dayStart+7*DAY+1),zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,valid,end,start,zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,valid,start,start,zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,valid,"2026-10-13T04:00:00Z",end,zone));
   rejects(IllegalArgumentException.class,()->SelectedCalendarReader.readAvailability(provider,valid,start,end,null));
   rejects(Exception.class,()->SelectedCalendarReader.readAvailability(provider,valid,"yesterday",end,zone));
   same(before,provider.instanceUris.size(),"No provider read for a malformed request");
   // Exactly seven days is allowed.
   SelectedCalendarReader.readAvailability(provider,valid,start,iso(dayStart+7*DAY),zone);

   // A provider that returns a row from another calendar, or an inverted interval, fails the read.
   provider.hostileRows=new ArrayList<>();provider.hostileRows.add(new String[]{"2","integer",Long.toString(dayStart),"integer",Long.toString(dayStart+HOUR),"integer","0","integer","0","integer","1","integer","","null"});
   rejects(IllegalStateException.class,()->SelectedCalendarReader.readAvailability(provider,valid,start,end,zone));
   provider.hostileRows.set(0,new String[]{"1","integer",Long.toString(dayStart+HOUR),"integer",Long.toString(dayStart),"integer","0","integer","0","integer","1","integer","","null"});
   rejects(IllegalStateException.class,()->SelectedCalendarReader.readAvailability(provider,valid,start,end,zone));
   provider.hostileRows=null;

   // Bounds: 200 occupying rows are returned; one more fails the whole read. Skipped rows do not count.
   Provider full=new Provider(directory);full.calendar(1,"BUSY",700);
   full.write("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<199) INSERT INTO instances SELECT 1,1000+i,'SECRET_MANY_TITLE','SECRET_DESCRIPTION','SECRET_LOCATION',"+dayStart+"+i*60000,"+dayStart+"+i*60000+60000,0,0,1,NULL,0 FROM n;"
    +"WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<49) INSERT INTO instances SELECT 1,2000+i,'SECRET_CANCELLED_TITLE','SECRET_DESCRIPTION','SECRET_LOCATION',"+dayStart+"+i*60000,"+dayStart+"+i*60000+60000,0,0,2,NULL,0 FROM n;");
   same(SelectedCalendarReader.AVAILABILITY_EVENTS,SelectedCalendarReader.readAvailability(full,chosen(full,1),start,end,zone).length(),"Rows at the bound");
   full.event(1,"OVER",dayStart+12*HOUR,dayStart+13*HOUR,false,0,1,null,false);
   rejects(SelectedCalendarReader.TooMany.class,()->SelectedCalendarReader.readAvailability(full,chosen(full,1),start,end,zone));
   Provider crowded=new Provider(directory);
   crowded.write("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<"+SelectedCalendarReader.AVAILABILITY_SOURCES+") INSERT INTO calendars SELECT i,'a@account.example','com.example','N','N',200,'o@owner.example' FROM n;");
   same(SelectedCalendarReader.AVAILABILITY_SOURCES,SelectedCalendarReader.availabilitySources(crowded).length(),"Sources at the bound");
   crowded.calendar(1000,"EXTRA",200);
   rejects(SelectedCalendarReader.TooMany.class,()->SelectedCalendarReader.availabilitySources(crowded));

   System.out.println("PASS selected Calendar availability reader");
  }finally{
   try(Stream<Path> files=Files.walk(directory)){files.sorted(Comparator.reverseOrder()).forEach(path->path.toFile().delete());}
  }
 }
}
