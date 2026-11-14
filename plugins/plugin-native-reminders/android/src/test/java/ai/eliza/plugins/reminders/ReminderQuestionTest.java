package ai.eliza.plugins.reminders;

import android.app.*;
import android.content.*;
import android.net.Uri;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.util.*;
import static org.junit.Assert.*;

/** Real engine/store/notification builders under Android shadows; no provider or model. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28,manifest=Config.NONE)
public class ReminderQuestionTest {
 public static class Receiver extends BroadcastReceiver {public void onReceive(Context c,Intent i){}}
 static final class Memory implements SecureStringStore {
  String name;Map<String,String> slots=new HashMap<>();boolean fail;
  Memory(String name){this.name=name;}
  public String identity(){return name;}
  public String read(String key){return slots.get(key);}
  public void write(String key,String value){if(fail)throw new IllegalStateException("storage unavailable");slots.put(key,value);}
 }
 static ReminderConfiguration configuration(String name,boolean ask){return new ReminderConfiguration(name,name+"-legacy",name+"-taps",name+"-channel","Reminder","Due reminder","Private reminder",name+".REMIND",name+".DECIDE",name+".OPEN",name+"-alarm:",name+"-decision:",name+"-tap:","id","occurrence","decision",name+":",Receiver.class,Activity.class,ask?"Ask Alpha":null);}
 @Test public void questionCancelRetainsNoticeAndExactTokenWhileNormalTapIsUnchanged()throws Exception{
  Context context=RuntimeEnvironment.getApplication();String name="question"+UUID.randomUUID().toString().replace("-","");Memory memory=new Memory(name);ReminderConfiguration config=configuration(name,true);ReminderEngine engine=ReminderEngine.get(context,config,c->memory);
  engine.schedule("reminder","Synthetic reminder","Owned fixture",System.currentTimeMillis()+100,null,null);String occurrence=engine.read("reminder").getString("occurrenceId");
  while(System.currentTimeMillis()<engine.read("reminder").getLong("at"))Thread.sleep(1);
  engine.dispatch(new Intent(config.remindAction).putExtra(config.idExtra,"reminder").putExtra(config.occurrenceExtra,occurrence));
  NotificationManager manager=context.getSystemService(NotificationManager.class);Notification notice=manager.getActiveNotifications()[0].getNotification();assertEquals(3,notice.actions.length);assertEquals("Done",notice.actions[0].title);assertEquals("Snooze 10 minutes",notice.actions[1].title);assertEquals("Ask Alpha",notice.actions[2].title);assertNotEquals(notice.contentIntent,notice.actions[2].actionIntent);
  JSONObject ledger=new JSONObject(memory.read(config.tapSlot));String open=null,ask=null;for(Iterator<String> it=ledger.keys();it.hasNext();){String key=it.next();if(ledger.getJSONObject(key).optBoolean("question"))ask=key;else open=key;}assertNotNull(open);assertNotNull(ask);
  engine.captureTap(ask);assertTrue(engine.pendingTap().getBoolean("question"));assertTrue(engine.pendingTap().getBoolean("retained"));
  memory.fail=true;try{engine.releaseQuestionTap(ask);fail("failed write accepted");}catch(IllegalStateException expected){}memory.fail=false;assertEquals(ask,engine.pendingTap().getString("token"));
  engine.releaseQuestionTap(ask);assertFalse(engine.pendingTap().has("token"));assertEquals(1,manager.getActiveNotifications().length);engine.captureTap(ask);assertTrue(engine.pendingTap().getBoolean("retained"));
  manager.cancel(config.notificationTag("reminder"),0);assertFalse("Absent OS action cannot authorize question",engine.pendingTap().getBoolean("retained"));
  engine.releaseQuestionTap(ask);engine.captureTap(open);assertFalse(engine.pendingTap().getBoolean("question"));assertTrue("Normal exact detail navigation remains available",engine.pendingTap().getBoolean("retained"));
  try{engine.releaseQuestionTap(open);fail("content tap released as question");}catch(IllegalStateException expected){}
 }
 /** Makes the current occurrence due now without waiting for its civil time. */
 static void dueNow(Context context,ReminderEngine engine,String id)throws Exception{synchronized(engine.store){SharedPreferences rows=new ReminderEnvelope(context,engine.store).records();JSONObject row=new JSONObject(rows.getString(id,null)).put("at",System.currentTimeMillis()-1);assertTrue(rows.edit().putString(id,row.toString()).commit());}}
 static void deliver(Context context,ReminderEngine engine,ReminderConfiguration config,String id)throws Exception{
  String occurrence=engine.read(id).getString("occurrenceId");dueNow(context,engine,id);
  engine.dispatch(new Intent(config.remindAction).putExtra(config.idExtra,id).putExtra(config.occurrenceExtra,occurrence));
 }
 static boolean noticed(Context context,ReminderConfiguration config,String id){for(android.service.notification.StatusBarNotification notice:context.getSystemService(NotificationManager.class).getActiveNotifications())if(config.notificationTag(id).equals(notice.getTag()))return true;return false;}
 @Test public void dailyReminderKeepsPostingAfterManyCompletedOccurrences()throws Exception{
  Context context=RuntimeEnvironment.getApplication();String name="daily"+UUID.randomUUID().toString().replace("-","");Memory memory=new Memory(name);ReminderConfiguration config=configuration(name,true);ReminderEngine engine=ReminderEngine.get(context,config,c->memory);
  java.time.LocalDate tomorrow=java.time.LocalDate.now(java.time.ZoneOffset.UTC).plusDays(1);
  JSONObject daily=new JSONObject().put("rule","daily").put("zone","UTC").put("date",tomorrow.toString()).put("time","09:00").put("leadMinutes",0);
  engine.schedule("daily","Synthetic reminder","Owned fixture",tomorrow.atTime(9,0).toInstant(java.time.ZoneOffset.UTC).toEpochMilli(),daily,null);
  for(int i=0;i<300;i++){
   String occurrence=engine.read("daily").getString("occurrenceId");deliver(context,engine,config,"daily");
   assertTrue("Delivery "+i+" posted",noticed(context,config,"daily"));
   JSONObject ledger=new JSONObject(memory.read(config.tapSlot));assertTrue(ledger.length()<512);
   // Both routes of this delivery survive prepareQuestion; earlier dismissed notices are reclaimed.
   assertEquals(2,ledger.length());int questions=0;JSONObject target=engine.selected("daily");
   for(Iterator<String> it=ledger.keys();it.hasNext();){JSONObject row=ledger.getJSONObject(it.next());assertTrue(ReminderTaps.same(target,row.getJSONObject("target")));if(row.optBoolean("question"))questions++;}
   assertEquals(1,questions);
   assertEquals("scheduled",engine.decide("daily",occurrence,"done").getString("status"));assertFalse(noticed(context,config,"daily"));
  }
 }
 @Test public void olderPendingTapIsNotReclaimed()throws Exception{
  Context context=RuntimeEnvironment.getApplication();String name="pending"+UUID.randomUUID().toString().replace("-","");Memory memory=new Memory(name);ReminderConfiguration config=configuration(name,true);ReminderEngine engine=ReminderEngine.get(context,config,c->memory);
  engine.schedule("older","Synthetic reminder","Owned fixture",System.currentTimeMillis()+60000,null,null);deliver(context,engine,config,"older");
  JSONObject ledger=new JSONObject(memory.read(config.tapSlot));String open=null,ask=null;for(Iterator<String> it=ledger.keys();it.hasNext();){String key=it.next();if(ledger.getJSONObject(key).optBoolean("question"))ask=key;else open=key;}
  engine.captureTap(open);context.getSystemService(NotificationManager.class).cancel(config.notificationTag("older"),0);
  engine.schedule("newer","Synthetic reminder","Owned fixture",System.currentTimeMillis()+60000,null,null);deliver(context,engine,config,"newer");
  assertTrue(noticed(context,config,"newer"));
  ledger=new JSONObject(memory.read(config.tapSlot));
  assertEquals("pending",ledger.getJSONObject(open).getString("state"));
  assertFalse("Untapped route without its notice is reclaimed",ledger.has(ask));
  assertEquals(open,engine.pendingTap().getString("token"));
 }
 @Test public void absentQuestionConfigurationPreservesTwoActions()throws Exception{
  Context context=RuntimeEnvironment.getApplication();String name="legacy"+UUID.randomUUID().toString().replace("-","");Memory memory=new Memory(name);ReminderConfiguration config=configuration(name,false);ReminderEngine engine=ReminderEngine.get(context,config,c->memory);
  engine.schedule("plain","Synthetic reminder","Owned fixture",System.currentTimeMillis()+100,null,null);String occurrence=engine.read("plain").getString("occurrenceId");while(System.currentTimeMillis()<engine.read("plain").getLong("at"))Thread.sleep(1);engine.dispatch(new Intent(config.remindAction).putExtra(config.idExtra,"plain").putExtra(config.occurrenceExtra,occurrence));
  for(android.service.notification.StatusBarNotification notice:context.getSystemService(NotificationManager.class).getActiveNotifications())if(config.notificationTag("plain").equals(notice.getTag())){assertEquals(2,notice.getNotification().actions.length);context.getSystemService(NotificationManager.class).cancel(notice.getTag(),0);return;}fail("Reminder missing");
 }
 /** Android 12 and later: only a host that already holds the exact-alarm capability is armed exactly. */
 @Test @Config(sdk=31,manifest=Config.NONE) public void heldExactAlarmCapabilityArmsOnTimeAndOtherHostsStayInexact()throws Exception{
  Context context=RuntimeEnvironment.getApplication();org.robolectric.shadows.ShadowAlarmManager alarms=org.robolectric.Shadows.shadowOf(context.getSystemService(AlarmManager.class));
  try{
   for(boolean held:new boolean[]{false,true}){
    org.robolectric.shadows.ShadowAlarmManager.setCanScheduleExactAlarms(held);
    String name="exact"+UUID.randomUUID().toString().replace("-","");ReminderEngine engine=ReminderEngine.get(context,configuration(name,false),c->new Memory(name));
    long at=System.currentTimeMillis()+3_600_000+(held?1000:0);engine.schedule("reminder","Synthetic reminder","Owned fixture",at,null,null);
    assertEquals("The record makes no alarm-clock promise","inexact",engine.read("reminder").getString("mode"));
    org.robolectric.shadows.ShadowAlarmManager.ScheduledAlarm armed=null;for(org.robolectric.shadows.ShadowAlarmManager.ScheduledAlarm alarm:alarms.getScheduledAlarms())if(alarm.getTriggerAtMs()==at)armed=alarm;
    assertNotNull(armed);assertTrue(armed.isAllowWhileIdle());
    assertEquals(held?org.robolectric.shadows.ShadowAlarmManager.WINDOW_EXACT:org.robolectric.shadows.ShadowAlarmManager.WINDOW_HEURISTIC,armed.getWindowLengthMs());
   }
  }finally{org.robolectric.shadows.ShadowAlarmManager.setCanScheduleExactAlarms(false);}
 }
 @Test public void dueReminderUsesTheHostIconAndKeepsThePlatformGlyphWithoutOne()throws Exception{
  Context context=RuntimeEnvironment.getApplication();
  for(int icon:new int[]{0,android.R.drawable.ic_dialog_info}){
   String name="icon"+UUID.randomUUID().toString().replace("-","");ReminderConfiguration plain=configuration(name,false);
   ReminderConfiguration config=new ReminderConfiguration(plain.envelopeName,plain.legacyName,plain.tapSlot,plain.channelId,plain.channelName,plain.channelDescription,plain.publicTitle,plain.remindAction,plain.decisionAction,plain.openAction,plain.alarmUriPrefix,plain.decisionUriPrefix,plain.tapUriPrefix,plain.idExtra,plain.occurrenceExtra,plain.decisionExtra,plain.notificationTagPrefix,plain.receiverClass,plain.activityClass,null,icon);
   assertEquals("The icon is presentation, not installed identity",plain.fingerprint(),config.fingerprint());
   ReminderEngine engine=ReminderEngine.get(context,config,c->new Memory(name));
   engine.schedule("reminder","Synthetic reminder","Owned fixture",System.currentTimeMillis()+3_600_000,null,null);deliver(context,engine,config,"reminder");
   Notification notice=null;for(android.service.notification.StatusBarNotification posted:context.getSystemService(NotificationManager.class).getActiveNotifications())if(config.notificationTag("reminder").equals(posted.getTag()))notice=posted.getNotification();
   assertNotNull(notice);int expected=icon!=0?icon:android.R.drawable.ic_popup_reminder;
   assertEquals(expected,notice.getSmallIcon().getResId());assertEquals(expected,notice.publicVersion.getSmallIcon().getResId());
  }
 }
 @org.robolectric.annotation.Implements(AlarmManager.class)
 public static class WithdrawnExactAlarm extends org.robolectric.shadows.ShadowAlarmManager {
  static int attempted;
  @org.robolectric.annotation.Implementation protected boolean canScheduleExactAlarms(){return true;}
  @org.robolectric.annotation.Implementation protected void setExactAndAllowWhileIdle(int type,long trigger,PendingIntent operation){attempted++;throw new SecurityException("Controlled capability withdrawal after check");}
 }
 @Test @Config(sdk=31,manifest=Config.NONE,shadows=WithdrawnExactAlarm.class) public void withdrawnExactAlarmCapabilityFallsBackWithoutLosingTheReminder()throws Exception{
  Context context=RuntimeEnvironment.getApplication();String name="withdrawn"+UUID.randomUUID().toString().replace("-","");
  WithdrawnExactAlarm.attempted=0;ReminderEngine engine=ReminderEngine.get(context,configuration(name,false),c->new Memory(name));
  long at=System.currentTimeMillis()+3_600_000;engine.schedule("reminder","Synthetic reminder","Owned fixture",at,null,null);
  assertEquals(1,WithdrawnExactAlarm.attempted);assertEquals("inexact",engine.read("reminder").getString("mode"));
  org.robolectric.shadows.ShadowAlarmManager.ScheduledAlarm scheduled=null;
  for(org.robolectric.shadows.ShadowAlarmManager.ScheduledAlarm alarm:org.robolectric.Shadows.shadowOf(context.getSystemService(AlarmManager.class)).getScheduledAlarms())if(alarm.getTriggerAtMs()==at)scheduled=alarm;
  assertNotNull(scheduled);assertTrue(scheduled.isAllowWhileIdle());assertEquals(org.robolectric.shadows.ShadowAlarmManager.WINDOW_HEURISTIC,scheduled.getWindowLengthMs());
 }
}
