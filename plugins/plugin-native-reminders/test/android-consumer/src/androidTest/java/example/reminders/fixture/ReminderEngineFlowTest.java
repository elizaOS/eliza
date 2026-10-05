package example.reminders.fixture;
import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Process;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import ai.eliza.plugins.reminders.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import java.util.UUID;
import static org.junit.Assert.*;

/** Actual Android storage/AlarmManager/notifications. No mocks; only test-owned synthetic content. */
@RunWith(AndroidJUnit4.class)
public final class ReminderEngineFlowTest {
 private Context context;
 private interface Check{boolean ready()throws Exception;}
 private void until(Check check)throws Exception{long end=SystemClock.elapsedRealtime()+10000;while(SystemClock.elapsedRealtime()<end){if(check.ready())return;SystemClock.sleep(50);}fail("Owned reminder effect did not settle");}
 private StatusBarNotification notification(String tag){for(StatusBarNotification n:context.getSystemService(NotificationManager.class).getActiveNotifications())if(tag.equals(n.getTag())&&n.getId()==0)return n;return null;}
 private Intent delivery(String name,String id,String occurrence){ReminderConfiguration c=FixtureHost.config(name);return new Intent(context,FixtureReceiver.class).setAction(c.remindAction).setData(Uri.parse(c.alarmUriPrefix+id+(occurrence==null?"":"/"+occurrence))).putExtra(c.idExtra,id).putExtra(c.occurrenceExtra,occurrence);}
 private PendingIntent alarm(String name,String id,String occurrence){return PendingIntent.getBroadcast(context,0,delivery(name,id,occurrence),PendingIntent.FLAG_NO_CREATE|PendingIntent.FLAG_IMMUTABLE);}
 private JSONObject createOperation(long due)throws Exception{return new JSONObject().put("type","reminder_create").put("fields",new JSONObject().put("title","Synthetic no-alert task").put("body","Owned fixture").put("schedule",new JSONObject().put("at",due).put("dueAt",due).put("alertMinutes",JSONObject.NULL).put("recurrence",JSONObject.NULL)));}
 private void cancel(ReminderEngine engine,String id)throws Exception{if(engine.read(id)!=null)engine.operate(UUID.randomUUID().toString(),"c".repeat(64),new JSONObject().put("type","reminder_cancel").put("target",engine.selected(id)));}
 private String token(String name,String id)throws Exception{JSONObject ledger=new JSONObject(context.getSharedPreferences("fixture-taps",Context.MODE_PRIVATE).getString("taps-"+name,"{}"));for(java.util.Iterator<String> it=ledger.keys();it.hasNext();){String token=it.next();if(id.equals(ledger.getJSONObject(token).getJSONObject("target").getString("reminderId")))return token;}throw new AssertionError("Missing opaque notification token");}
 @Test public void fullEngineFlowAndIsolation()throws Exception {
  String opt=InstrumentationRegistry.getArguments().getString("reminderEngineFixture");Assume.assumeTrue("Explicit fixture opt-in required",opt!=null);assertEquals("1",opt);assertTrue("Owned secondary user only",Process.myUid()/100000>0);
  context=InstrumentationRegistry.getInstrumentation().getTargetContext();assertEquals("example.reminders.fixture.consumer",context.getPackageName());if(android.os.Build.VERSION.SDK_INT>=33)assertEquals(PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS));
  for(String name:new String[]{"a","b"}){assertFalse("Fresh fixture storage required",context.getSharedPreferences("fixture-envelope-"+name,Context.MODE_PRIVATE).contains("envelope"));assertEquals(0,context.getSharedPreferences("fixture-legacy-"+name,Context.MODE_PRIVATE).getAll().size());}
  assertEquals(0,context.getSharedPreferences("fixture-taps",Context.MODE_PRIVATE).getAll().size());assertEquals(0,context.getSystemService(NotificationManager.class).getActiveNotifications().length);
  ReminderEngine a=FixtureHost.engine(context,"a"),b=FixtureHost.engine(context,"b");assertSame(a,FixtureHost.engine(context,"a"));assertNotSame(a,b);assertTrue(a.notificationsAllowed());assertTrue(b.notificationsAllowed());
  String shared="shared_"+UUID.randomUUID(),quiet="quiet_"+UUID.randomUUID();
  try {
   // Same physical envelope with different configuration must never fork state.
   ReminderConfiguration original=FixtureHost.config("a");ReminderConfiguration conflict=new ReminderConfiguration(original.envelopeName,original.legacyName,original.tapSlot,original.channelId,original.channelName,original.channelDescription,"Changed label",original.remindAction,original.decisionAction,original.openAction,original.alarmUriPrefix,original.decisionUriPrefix,original.tapUriPrefix,original.idExtra,original.occurrenceExtra,original.decisionExtra,original.notificationTagPrefix,original.receiverClass,original.activityClass);
   try{ReminderEngine.get(context,conflict,FixtureHost.STORAGE);fail("Conflicting engine configuration accepted");}catch(IllegalStateException expected){}
   long due=System.currentTimeMillis()+3600000;JSONObject operation=createOperation(due),created=a.operate(quiet,"a".repeat(64),operation);assertEquals("succeeded",created.getString("status"));assertEquals("pending",a.read(quiet).getString("status"));assertEquals("none",a.read(quiet).getString("mode"));assertTrue(a.read(quiet).isNull("alertMinutes"));assertNull(alarm("a",quiet,a.read(quiet).getString("occurrenceId")));assertNull(alarm("a",quiet,null));
   assertEquals(created.toString(),a.operate(quiet,"a".repeat(64),operation).toString());assertEquals(created.toString(),a.operationReceipt(quiet,"a".repeat(64),operation).toString());assertEquals(1,a.list().length());assertEquals(0,b.list().length());
   try{a.operate(quiet,"b".repeat(64),operation);fail("Changed approval binding accepted");}catch(IllegalArgumentException expected){}
   JSONObject oldTarget=a.selected(quiet),edit=new JSONObject().put("type","reminder_update").put("target",oldTarget).put("fields",new JSONObject().put("title","Edited synthetic task").put("body","Still no alert"));a.operate(UUID.randomUUID().toString(),"a".repeat(64),edit);assertEquals("Edited synthetic task",a.read(quiet).getString("title"));
   try{a.operate(UUID.randomUUID().toString(),"a".repeat(64),edit);fail("Stale reviewed target accepted");}catch(IllegalArgumentException expected){}
   a.dispatch(delivery("a",quiet,a.read(quiet).getString("occurrenceId")));assertEquals("pending",a.read(quiet).getString("status"));assertNull(notification("a:"+quiet));
   long atA=System.currentTimeMillis()+9000;JSONObject rowA=a.schedule(shared,"Synthetic A","Owned",atA,null,null);long atB=System.currentTimeMillis()+9000;JSONObject rowB=b.schedule(shared,"Synthetic B","Owned",atB,null,null);assertNotEquals(a.selected(shared).getString("sourceId"),b.selected(shared).getString("sourceId"));assertNotNull(alarm("a",shared,rowA.getString("occurrenceId")));assertNotNull(alarm("b",shared,rowB.getString("occurrenceId")));
   until(()->System.currentTimeMillis()>=Math.max(atA,atB));context.sendBroadcast(delivery("a",shared,rowA.getString("occurrenceId")));context.sendBroadcast(delivery("b",shared,rowB.getString("occurrenceId")));until(()->notification("a:"+shared)!=null&&notification("b:"+shared)!=null);
   Notification noticeA=notification("a:"+shared).getNotification(),noticeB=notification("b:"+shared).getNotification();assertEquals("posted",a.read(shared).getString("status"));assertEquals("posted",b.read(shared).getString("status"));
   String opaque=token("a",shared);assertTrue(opaque.matches("[0-9a-f-]{36}"));a.captureTap(opaque);JSONObject route=a.pendingTap();assertTrue(route.getBoolean("retained"));assertEquals(shared,route.getJSONObject("target").getString("reminderId"));a.consumeTap(opaque);assertFalse(a.pendingTap().has("token"));until(()->notification("a:"+shared)==null);assertNotNull(notification("b:"+shared));assertEquals("posted",a.read(shared).getString("status"));
   // Actual notification action PendingIntents route through the manifest receiver.
   noticeB.actions[1].actionIntent.send();until(()->"scheduled".equals(b.read(shared).getString("status")));assertTrue(b.read(shared).has("snoozedAt"));assertNotNull(alarm("b",shared,rowB.getString("occurrenceId")));assertEquals("unchanged",b.decide(shared,rowB.getString("occurrenceId"),"snooze").getString("status"));
   noticeA.actions[0].actionIntent.send();until(()->"completed".equals(a.read(shared).getString("status")));assertEquals("stale",a.decide(shared,rowA.getString("occurrenceId"),"done").getString("status"));assertEquals("scheduled",b.read(shared).getString("status"));assertNotNull(alarm("b",shared,rowB.getString("occurrenceId")));
  } finally {
   // This package/user was required empty. Cancel only this run's exact IDs, never global alarms.
   cancel(a,shared);cancel(b,shared);cancel(a,quiet);
   for(String name:new String[]{"a","b"})context.getSystemService(NotificationManager.class).deleteNotificationChannel(FixtureHost.config(name).channelId);
  }
 }
}
