package ai.eliza.plugins.calendar;

import android.content.ContentValues;
import android.content.Context;
import android.provider.CalendarContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Creation journal retention on synthetic rows; never inserts into the calendar provider. */
@RunWith(AndroidJUnit4.class)
public final class CalendarCreationRetentionTest {
 private static JSONObject row(String status,boolean acknowledged,long seq)throws Exception{
  JSONObject row=new JSONObject().put("argumentHash",new String(new char[64]).replace('\0','0')).put("calendarId","1").put("status",status).put("acknowledged",acknowledged);
  if("saved".equals(status))row.put("eventId","7");
  return seq<0?row:row.put("seq",seq);
 }

 @Test public void retiresOnlyOldestAcknowledgedSavedRows()throws Exception{
  JSONObject all=new JSONObject();
  all.put("legacy-a",row("saved",true,-1)).put("legacy-b",row("saved",true,-1));
  all.put("open-unknown",row("unknown",false,-1)).put("open-saved",row("saved",false,0));
  for(int i=1;i<=CalendarCreationStore.RETAINED_SETTLED;i++)all.put("settled-"+i,row("saved",true,i));
  long next=CalendarCreationStore.retire(all);
  assertEquals(CalendarCreationStore.RETAINED_SETTLED+1,next);
  assertFalse(all.has("legacy-a"));assertFalse(all.has("legacy-b"));
  assertTrue(all.has("open-unknown"));assertTrue(all.has("open-saved"));
  assertTrue(all.has("settled-1"));assertTrue(all.has("settled-"+CalendarCreationStore.RETAINED_SETTLED));
  assertEquals(CalendarCreationStore.RETAINED_SETTLED+2,all.length());
  // Sequential saves past the old 1000-row cap stay bounded once each is acknowledged.
  for(int i=0;i<CalendarCreationStore.MAX_OPEN+1;i++){long seq=CalendarCreationStore.retire(all);all.put("next-"+i,row("saved",true,seq));}
  assertTrue(all.length()<=CalendarCreationStore.RETAINED_SETTLED+3);
  assertTrue(all.has("next-"+CalendarCreationStore.MAX_OPEN));assertTrue(all.has("open-unknown"));
 }

 @Test public void openRowsRefuseDefinitelyWithoutWriting()throws Exception{
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
  String journal="calendar_retention_"+UUID.randomUUID().toString().replace("-","");
  JSONObject all=new JSONObject();
  for(int i=0;i<CalendarCreationStore.MAX_OPEN;i++)all.put(UUID.randomUUID().toString(),row("unknown",false,i));
  for(int i=0;i<CalendarCreationStore.RETAINED_SETTLED;i++)all.put(UUID.randomUUID().toString(),row("saved",true,CalendarCreationStore.MAX_OPEN+i));
  String stored=all.toString();
  assertTrue(context.getSharedPreferences(journal,Context.MODE_PRIVATE).edit().putString("operations",stored).commit());
  CalendarCreationStore store=new CalendarCreationStore(new CalendarConfiguration("Test account","test-local","Test calendar",journal,"example://calendar-creation/",0xff0000ff));
  ContentValues values=new ContentValues();values.put(CalendarContract.Events.CALENDAR_ID,1L);values.put(CalendarContract.Events.TITLE,"Synthetic");
  try{store.create(context,UUID.randomUUID().toString(),values,true);fail("Full journal admitted a creation");}
  catch(CalendarCreationStore.Full expected){}
  assertEquals(stored,context.getSharedPreferences(journal,Context.MODE_PRIVATE).getString("operations",null));
  context.deleteSharedPreferences(journal);
 }
}
