package example.reminders.fixture;

import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real registered Capacitor calls with a deliberately stalled synthetic store. */
@RunWith(AndroidJUnit4.class)
public final class ReminderTapIoTest {
 private ActivityScenario<BridgeActivity> scenario;
 private String evaluate(String source)throws Exception {
  String[] value={null};CountDownLatch done=new CountDownLatch(1);
  scenario.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript(source,result->{value[0]=result;done.countDown();}));
  assertTrue("WebView callback",done.await(5,TimeUnit.SECONDS));return value[0];
 }
 private void until(String expression)throws Exception {
  for(int i=0;i<100;i++){if("true".equals(evaluate("Boolean("+expression+")")))return;SystemClock.sleep(100);}
  fail("Missing bridge state: "+expression);
 }
 @Test public void slowTapStorageDoesNotBlockUi()throws Exception {
  assertEquals("1",InstrumentationRegistry.getArguments().getString("reminderTapIo"));
  assertTrue("Owned secondary user required",Process.myUid()/100000>0);
  assertEquals("example.reminders.fixture.consumer",InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName());
  try(ActivityScenario<BridgeActivity> owned=ActivityScenario.launch(BridgeActivity.class)){
   scenario=owned;until("window.Capacitor && typeof Capacitor.nativePromise === 'function'");
   boolean focused=false;
   for(int i=0;i<100;i++){boolean[] current={false};owned.onActivity(activity->current[0]=activity.hasWindowFocus());if(current[0]){focused=true;break;}SystemClock.sleep(100);}
   assertTrue("Foreground fixture",focused);
   for(String method:new String[]{"pendingReminderTap","consumeReminderTap","dismissReminderTap"}){
    CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
    AtomicBoolean mainRead=new AtomicBoolean();
    FixtureHost.readProbe=()->{
     if(Looper.myLooper()==Looper.getMainLooper())mainRead.set(true);
     entered.countDown();
     try{if(!release.await(10,TimeUnit.SECONDS))throw new IllegalStateException("Fixture storage gate expired");}
     catch(InterruptedException error){Thread.currentThread().interrupt();throw new IllegalStateException(error);}
    };
    try{
     evaluate("window.__settled=false;window.__failure=null;Capacitor.nativePromise('ConsumerReminders','"+method+"',{token:'"+UUID.randomUUID()+"'}).then(()=>window.__settled=true,error=>{window.__failure=String(error);window.__settled=true})");
     assertTrue(method+" reached storage",entered.await(5,TimeUnit.SECONDS));
     CountDownLatch heartbeat=new CountDownLatch(1);new Handler(Looper.getMainLooper()).post(heartbeat::countDown);
     assertTrue(method+" must leave UI responsive",heartbeat.await(2,TimeUnit.SECONDS));
     assertFalse(method+" reads must be off main",mainRead.get());
     assertEquals("false",evaluate("window.__settled"));
    }finally{FixtureHost.readProbe=null;release.countDown();}
    until("window.__settled");
    if(method.equals("pendingReminderTap"))assertEquals("null",evaluate("window.__failure"));
   }
  }finally{FixtureHost.readProbe=null;}
 }
}
