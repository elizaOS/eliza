package ai.eliza.plugins.agent.updater;
import ai.eliza.plugins.agent.health.NativeHealthEvidence;
import android.content.*;import android.content.pm.*;import android.os.*;import java.io.IOException;import java.security.SecureRandom;import java.util.*;import java.util.concurrent.*;import org.json.JSONObject;
/** Fresh native runtime observations only; never marks journal health. Call off
 * the main thread. Expected installed identity is read before and after IPC. */
public final class NativeHealthClient {
 public static JSONObject read(Context context,String target,String serviceClass,String distributionKey,long requestBudgetMillis)throws Exception {
  if(requestBudgetMillis<=0)throw new IllegalArgumentException("Positive host health request budget required");
  if(Looper.myLooper()==Looper.getMainLooper())throw new IOException("Health probe cannot block main thread");
  java.util.Objects.requireNonNull(target);java.util.Objects.requireNonNull(serviceClass);java.util.Objects.requireNonNull(distributionKey);PackageManager pm=context.getPackageManager();
  if(pm.checkSignatures(context.getPackageName(),target)!=PackageManager.SIGNATURE_MATCH)throw new IOException("Health peer signer mismatch");
  UpdateJournal.Identity before=PackageInstallCoordinator.installed(context,target);int expectedUid=pm.getApplicationInfo(target,0).uid;
  byte[] random=new byte[32];new SecureRandom().nextBytes(random);StringBuilder text=new StringBuilder();for(byte b:random)text.append(String.format(Locale.ROOT,"%02x",b&255));String nonce=text.toString();
  long started=SystemClock.elapsedRealtime(),deadline=Math.addExact(started,requestBudgetMillis);CompletableFuture<IBinder> connection=new CompletableFuture<>();CompletableFuture<JSONObject> response=new CompletableFuture<>();
  HandlerThread thread=new HandlerThread("SupervisorHealthReply");thread.start();
  Messenger replies=new Messenger(new Handler(thread.getLooper(),m->{
   try{
    if(m.sendingUid!=expectedUid)throw new IOException("Health reply UID mismatch");
    if(m.what!=200)throw new IOException("Health observation unavailable");
    String body=m.getData().getString("body");if(body==null||body.length()>4096)throw new IOException("Health response budget");
    JSONObject value=NativeHealthEvidence.parse(body,nonce,before.code,started,SystemClock.elapsedRealtime(),deadline);
    response.complete(value);
   }catch(Exception error){response.completeExceptionally(error);}return true;
  }));
  ServiceConnection callbacks=new ServiceConnection(){public void onServiceConnected(ComponentName name,IBinder binder){connection.complete(binder);}public void onServiceDisconnected(ComponentName name){response.completeExceptionally(new IOException("Health peer disconnected"));}public void onNullBinding(ComponentName name){connection.completeExceptionally(new IOException("Health binding unavailable"));}public void onBindingDied(ComponentName name){connection.completeExceptionally(new IOException("Health binding died"));response.completeExceptionally(new IOException("Health binding died"));}};
  boolean bound=false;
  try{
   bound=context.bindService(new Intent().setComponent(new ComponentName(target,serviceClass)),callbacks,Context.BIND_AUTO_CREATE);if(!bound)throw new IOException("Health service unavailable");
   IBinder binder=connection.get(remaining(deadline),TimeUnit.MILLISECONDS);Message request=Message.obtain();request.what=1;request.replyTo=replies;Bundle data=new Bundle();data.putString("nonce",nonce);data.putLong("versionCode",before.code);data.putLong("deadlineElapsed",deadline);request.setData(data);new Messenger(binder).send(request);
   JSONObject result=response.get(remaining(deadline),TimeUnit.MILLISECONDS);
   UpdateJournal.Identity after=PackageInstallCoordinator.installed(context,target);
   if(!before.matches(after)||SystemClock.elapsedRealtime()>=deadline||pm.getApplicationInfo(target,0).uid!=expectedUid)throw new IOException("Installed health subject changed or expired");
   ApplicationInfo info=pm.getApplicationInfo(target,PackageManager.GET_META_DATA);
   if(info.metaData==null||!result.getString("distribution").equals(info.metaData.getString(distributionKey)))throw new IOException("Health distribution mismatch");
   return result;
  }finally{try{if(bound)context.unbindService(callbacks);}finally{thread.quitSafely();}}
 }
 private static long remaining(long deadline)throws IOException {long left=deadline-SystemClock.elapsedRealtime();if(left<=0)throw new IOException("Health request expired");return left;}
}
