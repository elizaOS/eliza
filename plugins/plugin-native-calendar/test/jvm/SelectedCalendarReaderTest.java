package ai.eliza.plugins.calendar.read;
import org.json.*;
import java.time.*;
import java.util.*;
public final class SelectedCalendarReaderTest {
 static void require(boolean value){if(!value)throw new AssertionError();}
 interface Work {void run()throws Exception;}
 static void rejects(Work work)throws Exception{try{work.run();}catch(Exception expected){return;}throw new AssertionError("Expected rejection");}
 static long epoch(String value){return Instant.parse(value).toEpochMilli();}
 static class Rows implements android.database.Cursor {final List<Object[]> rows;int at=-1;Rows(List<Object[]> rows){this.rows=rows;}public boolean moveToFirst(){at=0;return !rows.isEmpty();}public boolean isNull(int column){return rows.get(at)[column]==null;}public int getType(int column){return rows.get(at)[column] instanceof Number?1:3;}public boolean moveToNext(){return ++at<rows.size();}public long getLong(int column){return ((Number)rows.get(at)[column]).longValue();}public String getString(int column){return (String)rows.get(at)[column];}public int getInt(int column){return ((Number)rows.get(at)[column]).intValue();}public void close(){}}
 static class Provider extends android.content.ContentResolver {
  List<Object[]> events=new ArrayList<>();String uri,selection,account="selected-account";boolean ownerDay,changeDuringRead;int eventReads;
  public android.database.Cursor query(android.net.Uri uri,String[] projection,String selection,String[] args,String sort){
   if(uri.value.equals("calendars/1"))return new Rows(Collections.singletonList(new Object[]{1L,account,"com.google","selected-name",500L,"selected-owner"}));
   require(Arrays.equals(args,new String[]{"1"}));require(selection.contains(" IN (?)"));
   if(uri.value.equals("calendars"))return new Rows(Collections.singletonList(new Object[]{1L}));
   this.uri=uri.value;this.selection=selection;require(Arrays.equals(projection,new String[]{"event_id","calendar_id","title","begin","end","all_day"}));
   if(ownerDay)require(selection.contains("all_day=0")&&selection.contains("all_day=1"));
   // Query fixture supplies the complete selected calendar envelope. Actual reader must
   // enforce each row's civil or instant membership; no UI filtering participates.
   eventReads++;if(changeDuringRead)account="new-account";return new Rows(events);
  }
 }
 static Object[] event(long id,String title,String start,String end,boolean allDay){return new Object[]{id,1L,title,epoch(start),epoch(end),allDay?1:0};}
 static JSONArray sources(Provider provider)throws Exception{return new JSONArray().put(new JSONObject().put("id","1").put("revision",ai.eliza.plugins.calendar.CalendarEventGuard.sourceIdentity(provider,1).getString("sourceRevision")));}
 static Set<String> titles(JSONArray rows)throws Exception{Set<String> result=new HashSet<>();for(int i=0;i<rows.length();i++)result.add(rows.getJSONObject(i).getString("title"));return result;}
 public static void main(String[] args)throws Exception {
  for(String zone:new String[]{"America/Los_Angeles","Asia/Tokyo"}){
   Provider provider=new Provider();provider.ownerDay=true;LocalDate day=LocalDate.parse("2026-10-08");String start=day.atStartOfDay(ZoneId.of(zone)).toInstant().toString().replace("Z",".000Z"),end=day.plusDays(1).atStartOfDay(ZoneId.of(zone)).toInstant().toString().replace("Z",".000Z");
   provider.events.add(event(1,"yesterday","2026-10-07T00:00:00Z","2026-10-08T00:00:00Z",true));provider.events.add(event(2,"today","2026-10-08T00:00:00Z","2026-10-09T00:00:00Z",true));provider.events.add(event(3,"tomorrow","2026-10-09T00:00:00Z","2026-10-10T00:00:00Z",true));provider.events.add(event(4,"multiday","2026-10-07T00:00:00Z","2026-10-09T00:00:00Z",true));provider.events.add(event(5,"timed",start,end,false));
   JSONArray rows=SelectedCalendarReader.readOwnerDay(provider,sources(provider),start,end,20,"2026-10-08","2026-10-09");require(titles(rows).equals(Set.of("today","multiday","timed")));
   String[] parts=provider.uri.split("/");require(Long.parseLong(parts[1])==Math.min(epoch(start),epoch("2026-10-08T00:00:00Z")));require(Long.parseLong(parts[2])==Math.max(epoch(end),epoch("2026-10-09T00:00:00Z")));
   rejects(()->SelectedCalendarReader.readOwnerDay(provider,sources(provider),start,end,1,"2026-10-08","2026-10-09"));
   provider.ownerDay=false;Set<String> legacy=titles(SelectedCalendarReader.read(provider,new JSONArray().put("1"),start,end,20));require(legacy.contains(zone.equals("Asia/Tokyo")?"yesterday":"tomorrow"));
  }
  for(String date:new String[]{"2026-03-08","2026-11-01"}){LocalDate day=LocalDate.parse(date);ZoneId zone=ZoneId.of("America/Los_Angeles");String start=day.atStartOfDay(zone).toInstant().toString().replace("Z",".000Z"),end=day.plusDays(1).atStartOfDay(zone).toInstant().toString().replace("Z",".000Z");Provider provider=new Provider();provider.ownerDay=true;provider.events.add(event(1,"today",date+"T00:00:00Z",day.plusDays(1)+"T00:00:00Z",true));provider.events.add(event(2,"tomorrow",day.plusDays(1)+"T00:00:00Z",day.plusDays(2)+"T00:00:00Z",true));require(titles(SelectedCalendarReader.readOwnerDay(provider,sources(provider),start,end,20,date,day.plusDays(1).toString())).equals(Set.of("today")));require(Duration.between(Instant.parse(start),Instant.parse(end)).toHours()==(date.contains("03-08")?23:25));}
  Provider changed=new Provider();changed.ownerDay=true;changed.events.add(event(1,"original","2026-10-08T15:00:00Z","2026-10-08T16:00:00Z",false));JSONArray approved=sources(changed);changed.account="different-account";rejects(()->SelectedCalendarReader.readOwnerDay(changed,approved,"2026-10-08T07:00:00.000Z","2026-10-09T07:00:00.000Z",20,"2026-10-08","2026-10-09"));require(changed.eventReads==0);
  changed.account="selected-account";changed.events.set(0,event(1,"legitimate daily content edit","2026-10-08T15:00:00Z","2026-10-08T16:00:00Z",false));require(titles(SelectedCalendarReader.readOwnerDay(changed,approved,"2026-10-08T07:00:00.000Z","2026-10-09T07:00:00.000Z",20,"2026-10-08","2026-10-09")).contains("legitimate daily content edit"));
  changed.changeDuringRead=true;rejects(()->SelectedCalendarReader.readOwnerDay(changed,approved,"2026-10-08T07:00:00.000Z","2026-10-09T07:00:00.000Z",20,"2026-10-08","2026-10-09"));require(changed.eventReads==2);
  System.out.println("PASS selected Calendar reader: LA/Tokyo civil dates, multi-day events, DST, provider query coverage/projection, overflow, source/account revision mismatch/race, daily content edits and unchanged foreground instant contract");
 }
}
