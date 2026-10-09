package example.calendar;

import android.Manifest;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.os.Process;
import android.os.SystemClock;
import android.provider.CalendarContract;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import ai.eliza.plugins.calendar.CalendarPlugin;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Independent renderer -> registered inherited Capacitor methods -> real provider/dialogs. */
@RunWith(AndroidJUnit4.class)
public final class ConsumerBridgeFlowTest {
 private ActivityScenario<ConsumerActivity> scenario;
 private String evaluate(String script)throws Exception {
  String[] result={null};CountDownLatch done=new CountDownLatch(1);
  scenario.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript(script,value->{result[0]=value;done.countDown();}));
  assertTrue("WebView callback",done.await(5,TimeUnit.SECONDS));return result[0];
 }
 private void until(String expression)throws Exception {for(int i=0;i<120;i++){if("true".equals(evaluate("Boolean("+expression+")")))return;SystemClock.sleep(100);}fail("Missing consumer bridge state: "+expression);}
 private void focus()throws Exception {for(int i=0;i<120;i++){boolean[] ready={false};scenario.onActivity(activity->ready[0]=activity.hasWindowFocus());if(ready[0])return;SystemClock.sleep(100);}fail("Consumer Activity did not regain focus");}
 private void start(String method,JSONObject arguments)throws Exception {focus();evaluate("window.__result=null;Capacitor.nativePromise('ConsumerCalendar',"+JSONObject.quote(method)+","+arguments+").then(value=>window.__result=value,error=>window.__result={error:String(error)})");}
 private JSONObject result()throws Exception {until("window.__result");JSONObject result=new JSONObject(evaluate("window.__result"));assertFalse(result.toString(),result.has("error"));return result;}
 private void click(String label,boolean permission)throws Exception {
  for(int i=0;i<120;i++){
   String early=evaluate("window.__result");if(!"null".equals(early))fail("Operation settled before native control "+label+": "+early);
   AccessibilityNodeInfo root=InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow();
   if(root!=null){java.util.ArrayDeque<AccessibilityNodeInfo> queue=new java.util.ArrayDeque<>();queue.add(root);while(!queue.isEmpty()){AccessibilityNodeInfo node=queue.removeFirst();String pkg=String.valueOf(node.getPackageName());boolean owned=permission?(pkg.equals("com.android.permissioncontroller")||pkg.equals("com.google.android.permissioncontroller")):pkg.equals("example.calendar.consumer");if(owned&&node.getText()!=null&&label.equalsIgnoreCase(node.getText().toString())&&node.isVisibleToUser()&&node.isClickable()&&node.performAction(AccessibilityNodeInfo.ACTION_CLICK))return;for(int j=0;j<node.getChildCount();j++){AccessibilityNodeInfo child=node.getChild(j);if(child!=null)queue.add(child);}}}
   SystemClock.sleep(100);
  }fail("Missing owned native control: "+label);
 }
 private void released(){scenario.onActivity(activity->{try{Object plugin=activity.getBridge().getPlugin("ConsumerCalendar").getInstance();java.lang.reflect.Field busy=CalendarPlugin.class.getDeclaredField("deleting"),dialog=CalendarPlugin.class.getDeclaredField("deleteDialog");busy.setAccessible(true);dialog.setAccessible(true);assertFalse(((java.util.concurrent.atomic.AtomicBoolean)busy.get(plugin)).get());assertNull(dialog.get(plugin));}catch(Exception error){throw new AssertionError(error);}});}
 private void awaitReview()throws Exception {for(int i=0;i<120;i++){boolean[] shown={false};scenario.onActivity(activity->{try{Object plugin=activity.getBridge().getPlugin("ConsumerCalendar").getInstance();java.lang.reflect.Field field=CalendarPlugin.class.getDeclaredField("deleteDialog");field.setAccessible(true);android.app.AlertDialog dialog=(android.app.AlertDialog)field.get(plugin);shown[0]=dialog!=null&&dialog.isShowing();}catch(Exception error){throw new AssertionError(error);}});if(shown[0])return;SystemClock.sleep(100);}fail("No owned Calendar confirmation appeared");}
 private JSONObject operation(JSONObject operation,String button)throws Exception{start("executeAgent",new JSONObject().put("operation",operation).put("operationId",UUID.randomUUID().toString()));click(button,false);JSONObject value=result();released();return value;}
 private boolean exists(Context context,long id){try(Cursor rows=context.getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,id),new String[]{"deleted"},null,null,null)){return rows!=null&&rows.moveToFirst()&&rows.getInt(0)==0;}}
 @Test public void workflowPermissionCallback()throws Exception {
  assertEquals("1",InstrumentationRegistry.getArguments().getString("calendarWorkflowPermission"));assertTrue(Process.myUid()/100000>0);
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();assertNotEquals(android.content.pm.PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.READ_CALENDAR));
  try(ActivityScenario<ConsumerActivity> owned=ActivityScenario.launch(ConsumerActivity.class)){
   scenario=owned;until("window.Capacitor && typeof Capacitor.nativePromise === 'function'");
   start("requestWorkflowReadAccess",new JSONObject());click("Allow",true);assertEquals("granted",result().getString("status"));
   assertEquals(android.content.pm.PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.READ_CALENDAR));
   start("workflowCalendars",new JSONObject());assertEquals("ready",result().getString("status"));
  }
 }
 @Test public void permissionAndReviewedProviderLifecycle()throws Exception {
  assertEquals("Owned fixture opt-in", "1",InstrumentationRegistry.getArguments().getString("calendarBridge"));assertTrue("Never operate in owner user",Process.myUid()/100000>0);
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
  assertNotEquals("Fresh ungranted permission fixture required",android.content.pm.PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.READ_CALENDAR));
  long eventId=0,calendarId=0;
  try(ActivityScenario<ConsumerActivity> owned=ActivityScenario.launch(ConsumerActivity.class)){
   scenario=owned;until("window.Capacitor && typeof Capacitor.nativePromise === 'function'");
   start("requestAccess",new JSONObject());click("Allow",true);assertEquals("granted",result().getString("status"));
   start("requestWorkflowReadAccess",new JSONObject());assertEquals("granted",result().getString("status"));
   start("prepareAgentSource",new JSONObject());JSONObject prepared=result();assertEquals(prepared.toString(),"ready",prepared.getString("status"));calendarId=Long.parseLong(prepared.getString("sourceId"));
   try(Cursor row=context.getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId),new String[]{"account_name","name","calendar_displayName"},null,null,null)){assertNotNull(row);assertTrue(row.moveToFirst());assertEquals("Consumer fixture",row.getString(0));assertEquals("consumer-local",row.getString(1));assertEquals("Fixture calendar",row.getString(2));}
   JSONObject source=new JSONObject().put("sourceId",prepared.getString("sourceId")).put("sourceRevision",prepared.getString("sourceRevision"));
   long begin=System.currentTimeMillis()+3600000;java.time.format.DateTimeFormatter format=new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter();
   JSONObject fields=new JSONObject().put("title","Consumer event "+UUID.randomUUID()).put("description","Synthetic consumer body").put("location","Fixture").put("start",format.format(java.time.Instant.ofEpochMilli(begin))).put("end",format.format(java.time.Instant.ofEpochMilli(begin+3600000))).put("timeZone","UTC");
   JSONObject created=operation(new JSONObject().put("type","calendar_create").put("source",source).put("fields",fields),"Create event");assertEquals(created.toString(),"applied",created.getString("status"));eventId=Long.parseLong(created.getJSONObject("result").getString("eventId"));assertTrue(exists(context,eventId));
   JSONObject target=new JSONObject(source.toString()).put("eventId",Long.toString(eventId)).put("revision",created.getJSONObject("result").getString("revision"));
   JSONObject read=operation(new JSONObject().put("type","calendar_read_selected").put("target",target),"Share with agent");for(String key:new String[]{"title","description","location","start","end","timeZone"})assertEquals(key,fields.getString(key),read.getJSONObject("result").getJSONObject("fields").getString(key));
   JSONObject changed=new JSONObject(fields.toString()).put("title","Edited consumer event");JSONObject updated=operation(new JSONObject().put("type","calendar_update").put("target",target).put("fields",changed),"Update event");assertEquals(updated.toString(),"applied",updated.getString("status"));
   start("executeAgent",new JSONObject().put("operation",new JSONObject().put("type","calendar_delete").put("target",target)).put("operationId",UUID.randomUUID().toString()));assertEquals("conflict",result().getString("status"));assertTrue(exists(context,eventId));released();
   target.put("revision",updated.getJSONObject("result").getString("revision"));JSONObject deletion=new JSONObject().put("type","calendar_delete").put("target",target);
   assertEquals("cancelled",operation(deletion,"Cancel").getString("status"));assertTrue(exists(context,eventId));
   // The provider changes after review appears: atomic revision checks must prevent deletion.
   start("executeAgent",new JSONObject().put("operation",deletion).put("operationId",UUID.randomUUID().toString()));awaitReview();
   android.content.ContentValues concurrent=new android.content.ContentValues();concurrent.put("description","Concurrent owned fixture edit");assertEquals(1,context.getContentResolver().update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,eventId),concurrent,null,null));
   click("Delete event",false);assertEquals("conflict",result().getString("status"));released();assertTrue(exists(context,eventId));
   concurrent.put("description",changed.getString("description"));assertEquals(1,context.getContentResolver().update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI,eventId),concurrent,null,null));
   // Pause cancels an outstanding review through the inherited lifecycle handler.
   start("executeAgent",new JSONObject().put("operation",deletion).put("operationId",UUID.randomUUID().toString()));awaitReview();owned.moveToState(androidx.lifecycle.Lifecycle.State.STARTED);owned.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);assertEquals("cancelled",result().getString("status"));released();assertTrue(exists(context,eventId));
   assertEquals("applied",operation(deletion,"Delete event").getString("status"));assertFalse(exists(context,eventId));
  }finally{
   if(calendarId>0){try(Cursor row=context.getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId),new String[]{"account_name","name"},null,null,null)){assertNotNull(row);assertTrue(row.moveToFirst());assertEquals("Consumer fixture",row.getString(0));assertEquals("consumer-local",row.getString(1));}
    android.net.Uri exact=ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI,calendarId).buildUpon().appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER,"true").appendQueryParameter("account_name","Consumer fixture").appendQueryParameter("account_type",CalendarContract.ACCOUNT_TYPE_LOCAL).build();assertEquals(1,context.getContentResolver().delete(exact,null,null));}
  }
 }
}
