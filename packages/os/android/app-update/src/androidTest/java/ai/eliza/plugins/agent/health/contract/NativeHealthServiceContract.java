package ai.eliza.plugins.agent.health.contract;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import java.util.concurrent.*;
/** Binds a host's declared NativeHealthService from the instrumentation app. That app must share
 * the service signer and must not be the supervisor package, so the service must answer 403. */
public final class NativeHealthServiceContract {
 private NativeHealthServiceContract() {}
 public static void assertRefusesSameSigner(Context context,ComponentName service)throws Exception {
  if(Looper.myLooper()==Looper.getMainLooper())throw new AssertionError("Contract must run on instrumentation worker");
  if(context.getPackageManager().checkSignatures(context.getPackageName(),service.getPackageName())!=PackageManager.SIGNATURE_MATCH)throw new AssertionError("Caller does not share the service signer");
  HandlerThread thread=new HandlerThread("NativeHealthServiceContract");thread.start();
  CompletableFuture<IBinder> ready=new CompletableFuture<>();CompletableFuture<Integer> reply=new CompletableFuture<>();
  ServiceConnection connection=new ServiceConnection(){
   @Override public void onServiceConnected(ComponentName name,IBinder binder){ready.complete(binder);}
   @Override public void onServiceDisconnected(ComponentName name){}
  };
  boolean bound=false;
  try {
   bound=context.bindService(new Intent().setComponent(service),connection,Context.BIND_AUTO_CREATE);
   if(!bound)throw new AssertionError("Health service did not bind");
   // A well-formed request: only the sender identity can make the service refuse it.
   Bundle data=new Bundle();data.putString("nonce","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");data.putLong("versionCode",0);data.putLong("deadlineElapsed",SystemClock.elapsedRealtime()+5000);
   Message request=Message.obtain();request.what=1;request.setData(data);
   request.replyTo=new Messenger(new Handler(thread.getLooper(),m->{reply.complete(m.what);return true;}));
   new Messenger(ready.get(10,TimeUnit.SECONDS)).send(request);
   int code=reply.get(10,TimeUnit.SECONDS);
   if(code!=403)throw new AssertionError("Same-signer caller was not refused: "+code);
  } finally {
   try{if(bound)context.unbindService(connection);}finally{thread.quitSafely();}
  }
 }
}
