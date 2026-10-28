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
 @Test public void absentQuestionConfigurationPreservesTwoActions()throws Exception{
  Context context=RuntimeEnvironment.getApplication();String name="legacy"+UUID.randomUUID().toString().replace("-","");Memory memory=new Memory(name);ReminderConfiguration config=configuration(name,false);ReminderEngine engine=ReminderEngine.get(context,config,c->memory);
  engine.schedule("plain","Synthetic reminder","Owned fixture",System.currentTimeMillis()+100,null,null);String occurrence=engine.read("plain").getString("occurrenceId");while(System.currentTimeMillis()<engine.read("plain").getLong("at"))Thread.sleep(1);engine.dispatch(new Intent(config.remindAction).putExtra(config.idExtra,"plain").putExtra(config.occurrenceExtra,occurrence));
  for(android.service.notification.StatusBarNotification notice:context.getSystemService(NotificationManager.class).getActiveNotifications())if(config.notificationTag("plain").equals(notice.getTag())){assertEquals(2,notice.getNotification().actions.length);context.getSystemService(NotificationManager.class).cancel(notice.getTag(),0);return;}fail("Reminder missing");
 }
}
