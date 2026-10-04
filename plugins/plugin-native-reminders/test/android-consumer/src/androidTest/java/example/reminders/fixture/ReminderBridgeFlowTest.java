package example.reminders.fixture;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Process;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real WebView -> registered inherited Capacitor methods -> Android permissions/storage. */
@RunWith(AndroidJUnit4.class)
public final class ReminderBridgeFlowTest {
 private ActivityScenario<BridgeActivity> scenario;
 private String evaluate(String source)throws Exception {String[] value={null};CountDownLatch latch=new CountDownLatch(1);scenario.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript(source,result->{value[0]=result;latch.countDown();}));assertTrue("WebView callback",latch.await(5,TimeUnit.SECONDS));return value[0];}
 private void until(String expression)throws Exception {for(int i=0;i<120;i++){if("true".equals(evaluate("Boolean("+expression+")")))return;SystemClock.sleep(100);}fail("Missing bridge state: "+expression);}
 private void focus()throws Exception {for(int i=0;i<120;i++){boolean[] focused={false};scenario.onActivity(activity->focused[0]=activity.hasWindowFocus());if(focused[0])return;SystemClock.sleep(100);}fail("Bridge Activity did not regain focus");}
 private void start(String method,JSONObject args)throws Exception {focus();evaluate("window.__result=null;Capacitor.nativePromise('ConsumerReminders',"+JSONObject.quote(method)+","+args+").then(v=>window.__result=v,e=>window.__result={bridgeError:String(e)})");}
 private JSONObject result()throws Exception {until("window.__result");return new JSONObject(evaluate("window.__result"));}
 private JSONObject call(String method,JSONObject args)throws Exception {start(method,args);JSONObject value=result();assertFalse(value.toString(),value.has("bridgeError"));return value;}
 private JSONObject bound(JSONObject operation)throws Exception{return new JSONObject().put("operationId",UUID.randomUUID().toString()).put("bindingHash","a".repeat(64)).put("operation",operation);}
 private void permission(String resourceId)throws Exception {
  android.app.UiAutomation ui=InstrumentationRegistry.getInstrumentation().getUiAutomation();
  android.accessibilityservice.AccessibilityServiceInfo service=ui.getServiceInfo();int flags=service.flags;
  service.flags|=android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;ui.setServiceInfo(service);
  try {
  for(int i=0;i<120;i++){
   if(!"null".equals(evaluate("window.__result")))fail("Resolved before permission control: "+evaluate("window.__result"));
   AccessibilityNodeInfo root=InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow();
   if(root!=null){java.util.ArrayDeque<AccessibilityNodeInfo> nodes=new java.util.ArrayDeque<>();nodes.add(root);while(!nodes.isEmpty()){AccessibilityNodeInfo node=nodes.removeFirst();String pkg=String.valueOf(node.getPackageName());if((pkg.equals("com.android.permissioncontroller")||pkg.equals("com.google.android.permissioncontroller"))&&java.util.Set.of("com.android.permissioncontroller:id/"+resourceId,"com.google.android.permissioncontroller:id/"+resourceId).contains(String.valueOf(node.getViewIdResourceName()))&&node.isVisibleToUser()&&node.isClickable()&&node.performAction(AccessibilityNodeInfo.ACTION_CLICK))return;for(int child=0;child<node.getChildCount();child++){AccessibilityNodeInfo value=node.getChild(child);if(value!=null)nodes.add(value);}}}
   SystemClock.sleep(100);
  }fail("Missing permission control: "+resourceId);
  } finally { service.flags=flags;ui.setServiceInfo(service); }
 }
 @Test public void permissionCallbackReviewedOperationsAndResume()throws Exception {
  assertEquals("1",InstrumentationRegistry.getArguments().getString("reminderBridge"));assertTrue("Owned secondary user required",Process.myUid()/100000>0);assertTrue("Notification permission runtime requires API33+",android.os.Build.VERSION.SDK_INT>=33);
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();assertEquals("example.reminders.fixture.consumer",context.getPackageName());assertNotEquals("Fresh ungranted fixture required",PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS));
  assertFalse(context.getSharedPreferences("fixture-bridge-envelope",Context.MODE_PRIVATE).contains("envelope"));
  String id="bridge_"+UUID.randomUUID();
  try(ActivityScenario<BridgeActivity> owned=ActivityScenario.launch(BridgeActivity.class)){
   scenario=owned;until("window.Capacitor && typeof Capacitor.nativePromise === 'function'");
   JSONObject schedule=new JSONObject().put("id",id).put("title","Synthetic bridge reminder").put("body","Owned fixture").put("at",System.currentTimeMillis()+3600000);
   start("scheduleReminder",schedule);permission("permission_deny_button");assertEquals("permission-denied",result().getString("status"));assertEquals(0,call("listReminders",new JSONObject()).getJSONArray("reminders").length());
   start("scheduleReminder",schedule);permission("permission_allow_button");assertEquals("scheduled",result().getString("status"));assertEquals(PackageManager.PERMISSION_GRANTED,context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS));
   JSONObject listed=call("listReminders",new JSONObject());assertTrue(listed.getBoolean("notificationsEnabled"));assertEquals(1,listed.getJSONArray("reminders").length());assertEquals(id,listed.getJSONArray("reminders").getJSONObject(0).getString("id"));
   JSONObject target=call("selectedReminder",new JSONObject().put("id",id));
   JSONObject read=call("operateReminder",bound(new JSONObject().put("type","reminder_read_selected").put("target",target)));assertEquals("succeeded",read.getString("status"));assertEquals("Synthetic bridge reminder",read.getJSONObject("result").getJSONObject("fields").getString("title"));
   JSONObject edit=bound(new JSONObject().put("type","reminder_update").put("target",target).put("fields",new JSONObject().put("title","Edited bridge reminder").put("body","Owned update")));
   JSONObject changed=call("operateReminder",edit);assertEquals("succeeded",changed.getString("status"));assertEquals(changed.toString(),call("reminderOperationReceipt",edit).toString());
   start("operateReminder",bound(new JSONObject().put("type","reminder_cancel").put("target",target)));assertTrue("Stale revision must reject",result().has("bridgeError"));assertEquals("scheduled",call("listReminders",new JSONObject()).getJSONArray("reminders").getJSONObject(0).getString("status"));
   // No pause-cancel API exists. Exercise actual inherited resume notification instead.
   evaluate("window.__resumed=0;Capacitor.nativeCallback('ConsumerReminders','addListener',{eventName:'appResumed'},()=>window.__resumed++)");
   // Flush listener registration through the same bridge before changing lifecycle.
   call("listReminders",new JSONObject());until("window.__resumed>0");evaluate("window.__resumeBefore=window.__resumed");owned.moveToState(androidx.lifecycle.Lifecycle.State.STARTED);owned.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);until("window.__resumed>window.__resumeBefore");
   JSONObject fresh=call("selectedReminder",new JSONObject().put("id",id));JSONObject cancelled=call("cancelReminder",new JSONObject().put("id",id).put("target",fresh).put("operationId",UUID.randomUUID().toString()).put("bindingHash","a".repeat(64)));assertEquals("cancelled",cancelled.getString("status"));assertEquals("cancelled",call("listReminders",new JSONObject()).getJSONArray("reminders").getJSONObject(0).getString("status"));
  }finally{
   ai.eliza.plugins.reminders.ReminderEngine engine=BridgeReminder.engine(context);if(engine.read(id)!=null&&!"cancelled".equals(engine.read(id).getString("status")))engine.operate(UUID.randomUUID().toString(),"a".repeat(64),new JSONObject().put("type","reminder_cancel").put("target",engine.selected(id)));
   context.getSystemService(android.app.NotificationManager.class).deleteNotificationChannel("fixture-bridge-channel");
  }
 }
}
