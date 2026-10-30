package ai.eliza.plugins.calendar.read;
import ai.eliza.plugins.calendar.CalendarConfiguration;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs the product shared CalendarReadAccess on the JVM against a stand-in provider that holds a
 * chosen number of instances and counts how many the reader takes. It checks the bound and
 * the query the reader sends. It is not Android CalendarProvider and not a device run.
 */
public final class CalendarReadWindowTest {
 static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
 static void same(Object expected,Object actual,String message){if(!String.valueOf(expected).equals(String.valueOf(actual)))throw new AssertionError(message+"\n expected "+expected+"\n actual   "+actual);}
 /** Instances in start order: row n begins at base+n minutes; every third row is a recurrence. */
 static final class Provider extends ContentResolver {
  final int held;final long base;int taken,queries;String uri,selection,sort;String[] projection,arguments;boolean closed;
  Provider(int held,long base){this.held=held;this.base=base;}
  @Override public Cursor query(Uri target,String[] fields,String where,String[] values,String order){
   queries++;uri=target.value;projection=fields;selection=where;arguments=values;sort=order;
   return new Cursor(){
    int at=-1;
    public boolean moveToFirst(){at=0;return held>0;}
    public boolean moveToNext(){if(at+1>=held){at=held;return false;}at++;taken=Math.max(taken,at+1);return true;}
    public boolean isNull(int column){return column==3||(column==8&&at%3!=0);}
    public int getType(int column){return FIELD_TYPE_INTEGER;}
    public long getLong(int column){return column==0?1000+at:column==1?7:column==5?base+at*60000L:column==6?base+at*60000L+10000:0;}
    public String getString(int column){return column==2?"Row "+at:column==4?"Hall":column==8&&at%3==0?"FREQ=DAILY":null;}
    public int getInt(int column){return column==7&&at==1?1:0;}
    public void close(){closed=true;}
   };
  }
 }
 static JSONObject read(Provider provider)throws Exception{return new CalendarReadAccess(provider).window(provider.base,provider.base+90L*86400000L,2000);}
 public static void main(String[] arguments)throws Exception{
  long base=1790000000000L;
  CalendarConfiguration legacy=new CalendarConfiguration("Host","local","Calendar","journal","host://creation/",0);
  CalendarConfiguration configured=new CalendarConfiguration("Host","local","Calendar","journal","host://creation/",0,2000);
  same(0,legacy.maximumReadEvents,"The legacy configuration retains complete reads");same(2000,configured.maximumReadEvents,"The host selects its explicit bound");same(legacy.journalName,configured.journalName,"Read policy does not alter installed journal identity");
  try{new CalendarConfiguration("Host","local","Calendar","journal","host://creation/",0,-1);throw new AssertionError("Negative bound accepted");}catch(IllegalArgumentException expected){}
  Provider complete=new Provider(2101,base);same(2101,new CalendarReadAccess(complete).events(base,base+90L*86400000L).length(),"Legacy reads remain complete above the host bound");

  Provider empty=new Provider(0,base);JSONObject none=read(empty);
  same(0,none.getJSONArray("events").length(),"No instances");require(!none.getBoolean("truncated"),"An empty range is complete");require(empty.closed,"The cursor is closed");

  Provider exact=new Provider(2000,base);JSONObject whole=read(exact);
  same(2000,whole.getJSONArray("events").length(),"Exactly the bound is returned whole");
  require(!whole.getBoolean("truncated"),"Exactly 2,000 instances is a complete result, not a limited one");
  same(1,exact.queries,"One provider query");
  same("instances/"+base+"/"+(base+90L*86400000L),exact.uri,"The instance range is the requested range");
  same("[event_id, calendar_id, title, description, eventLocation, begin, end, allDay, rrule]",Arrays.toString(exact.projection),"Projection");
  same("deleted=0",exact.selection,"Deleted instances are excluded");require(exact.arguments==null,"No selection arguments");same("begin ASC",exact.sort,"Start order decides which instances are kept");
  JSONArray rows=whole.getJSONArray("events");JSONObject first=rows.getJSONObject(0),second=rows.getJSONObject(1),last=rows.getJSONObject(1999);
  same("[allDay, begin, calendarId, end, id, location, recurring, title]",new java.util.TreeSet<>(first.keySet()).toString(),"Row fields of the shared reader (a null description is omitted)");
  same("1000|7|Row 0|Hall|"+base+"|"+(base+10000)+"|false|true",first.getString("id")+"|"+first.getString("calendarId")+"|"+first.getString("title")+"|"+first.getString("location")+"|"+first.getLong("begin")+"|"+first.getLong("end")+"|"+first.getBoolean("allDay")+"|"+first.getBoolean("recurring"),"Row values");
  require(second.getBoolean("allDay")&&!second.getBoolean("recurring"),"All-day and non-recurring rows are carried");
  same(base+1999*60000L,last.getLong("begin"),"The last kept row is the 2,000th by start");

  Provider over=new Provider(2001,base);JSONObject limited=read(over);
  same(2000,limited.getJSONArray("events").length(),"One instance past the bound is not returned");
  require(limited.getBoolean("truncated"),"One instance past the bound is reported as an incomplete result");
  same(base+1999*60000L,limited.getJSONArray("events").getJSONObject(1999).getLong("begin"),"The earliest 2,000 are the ones kept");
  require(over.closed,"The cursor is closed after an incomplete read");

  Provider huge=new Provider(250000,base);JSONObject bounded=read(huge);
  same(2000,bounded.getJSONArray("events").length(),"A very large provider result stays bounded");require(bounded.getBoolean("truncated"),"and is reported incomplete");
  same(2001,huge.taken,"Reading stops at the first row past the bound");

  for(long[] range:new long[][]{{-1,10},{10,10},{10,9},{0,370L*86400000L+1}}){
   Provider refused=new Provider(1,base);
   try{new CalendarReadAccess(refused).window(range[0],range[1],2000);throw new AssertionError("Range "+range[0]+".."+range[1]+" must be refused");}catch(IllegalArgumentException expected){same(0,refused.queries,"A refused range never reaches the provider");}
  }
  same(1,new CalendarReadAccess(new Provider(1,base)).window(0,370L*86400000L,2000).getJSONArray("events").length(),"A 370-day range is allowed");
  ContentResolver silent=new ContentResolver(){@Override public Cursor query(Uri u,String[] p,String s,String[] a,String o){return null;}};
  try{new CalendarReadAccess(silent).window(base,base+1,2000);throw new AssertionError("A provider without a cursor must fail");}catch(IllegalStateException expected){/* The plugin reports this as a failed read, never as an empty calendar. */}
  Provider invalid=new Provider(1,base);try{new CalendarReadAccess(invalid).window(base,base+1,0);throw new AssertionError("Zero explicit bound accepted");}catch(IllegalArgumentException expected){same(0,invalid.queries,"Invalid bound never reads provider");}

  Provider linkedInstances=new Provider(2001,base);
  ContentResolver linked=new ContentResolver(){public Cursor query(Uri uri,String[] fields,String where,String[] values,String order){
   if(!uri.value.equals("events"))return linkedInstances.query(uri,fields,where,values,order);
   require(where.contains("_id IN ("),"Bounded metadata query is restricted to returned IDs");require(!where.matches(".*\\b3000\\b.*"),"Unreturned event metadata excluded");
   same("owned.host",values[0],"Metadata is confined to the host package");
   return new Cursor(){int at=-1;public boolean moveToFirst(){at=0;return true;}public boolean moveToNext(){return ++at<2;}public boolean isNull(int c){return false;}public int getType(int c){return 1;}public long getLong(int c){return 1000+at;}public String getString(int c){return at==0?"host://creation/afc732b3-416e-4dd3-98ce-0bd854106c46":"host://creation/invalid";}public int getInt(int c){return 0;}public void close(){}};
  }};
  JSONArray linkedRows=new CalendarReadAccess(linked,"owned.host","host://creation/").window(base,base+90L*86400000L,2000).getJSONArray("events");
  same("afc732b3-416e-4dd3-98ce-0bd854106c46",linkedRows.getJSONObject(0).getString("creationId"),"Creation identity survives bounded reads");require(!linkedRows.getJSONObject(1).has("creationId"),"Malformed metadata is not an identity");
  System.out.println("PASS shared Calendar window: complete default, bounded first rows, overflow, closure, exact range and query, permission-independent provider failures");
 }
}
