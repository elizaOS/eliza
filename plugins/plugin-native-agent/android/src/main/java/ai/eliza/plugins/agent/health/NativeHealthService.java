package ai.eliza.plugins.agent.health;
import android.app.Service;import android.content.Intent;import android.content.pm.PackageManager;import android.os.*;
import java.util.*;import java.util.concurrent.*;import org.json.JSONObject;
/** Native observations plus isolated storage diagnostics, not a health verdict. Signature
 * permission and actual Messenger sender UID both gate every request. */
public abstract class NativeHealthService extends Service {
 protected abstract String supervisorPackage();
 protected abstract long requestBudgetMillis();
 protected abstract long uiBudgetMillis();
 protected abstract long versionCode();
 protected abstract String distribution();
 protected abstract JSONObject runtimeObservation()throws Exception;
 protected abstract void checkStorage(long deadline)throws Exception;
 protected abstract JSONObject uiObservation(long deadline)throws Exception;
 protected abstract boolean runtimeUnchanged(JSONObject observation)throws Exception;
 private final ThreadPoolExecutor worker=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(1),r->new Thread(r,"OtaHealthProbe"),new ThreadPoolExecutor.AbortPolicy());
 private final Messenger inbound=new Messenger(new Handler(Looper.getMainLooper(),this::receive));
 private volatile boolean closed;
 @Override public IBinder onBind(Intent intent){return inbound.getBinder();}
 private boolean authorized(int uid){String[] names=getPackageManager().getPackagesForUid(uid);return names!=null&&names.length==1&&supervisorPackage().equals(names[0])&&getPackageManager().checkSignatures(uid,android.os.Process.myUid())==PackageManager.SIGNATURE_MATCH;}
 private static void reply(Messenger destination,int code,String body){if(destination==null)return;try{Message m=Message.obtain();m.what=code;Bundle data=new Bundle();data.putString("body",body);m.setData(data);destination.send(m);}catch(RemoteException ignored){}}
 private boolean receive(Message message){
  Messenger destination=message.replyTo;
  if(!authorized(message.sendingUid)){reply(destination,403,"unauthorized");return true;}
  try{
   Bundle b=message.getData();if(closed||message.what!=1||b.size()!=3||!b.keySet().equals(new HashSet<>(Arrays.asList("nonce","versionCode","deadlineElapsed"))))throw new IllegalArgumentException();
   if(!(b.get("nonce") instanceof String)||!(b.get("versionCode") instanceof Long)||!(b.get("deadlineElapsed") instanceof Long))throw new IllegalArgumentException();
   String nonce=b.getString("nonce");long version=b.getLong("versionCode"),deadline=b.getLong("deadlineElapsed"),now=SystemClock.elapsedRealtime();
   if(nonce==null||!nonce.matches("[a-f0-9]{64}")||version!=versionCode()||deadline<=now||requestBudgetMillis()<=0||uiBudgetMillis()<=0||deadline-now>requestBudgetMillis())throw new IllegalArgumentException();
   worker.execute(()->{
    try{
     if(closed||SystemClock.elapsedRealtime()>=deadline)return;
     JSONObject value=runtimeObservation().put("schemaVersion",5).put("nonce",nonce).put("versionCode",versionCode()).put("distribution",distribution());
     checkStorage(deadline);value.put("diagnosticStorageResponsive",true);
     JSONObject ui=uiObservation(Math.min(deadline,Math.addExact(SystemClock.elapsedRealtime(),uiBudgetMillis())));
     for(String key:new String[]{"activityState","rendererResponsive","contentPresent"})value.put(key,ui.get(key));
     if(!runtimeUnchanged(value))throw new java.io.IOException("Runtime changed during UI observation");
     long observed=SystemClock.elapsedRealtime();if(closed||observed>=deadline)return;value.put("observedElapsed",observed);reply(destination,200,value.toString());
    }catch(Exception failure){reply(destination,503,"observation_unavailable");}
   });
  }catch(RuntimeException failure){reply(destination,400,"invalid_or_busy");}
  return true;
 }
 @Override public void onDestroy(){closed=true;worker.shutdownNow();super.onDestroy();}
}
