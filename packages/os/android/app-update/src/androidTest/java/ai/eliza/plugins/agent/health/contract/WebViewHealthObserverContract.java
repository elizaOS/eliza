package ai.eliza.plugins.agent.health.contract;
import ai.eliza.plugins.agent.health.WebViewHealthObserver;
import android.os.*;
import android.app.Activity;
import android.content.Context;
import android.webkit.*;
import java.io.IOException;
import java.util.concurrent.*;
import org.json.JSONObject;
/** Policy/thread cases and controlled WebView callback races. Hosts also qualify real DOM rendering. */
public final class WebViewHealthObserverContract {
 private WebViewHealthObserverContract() {}
 public static void run()throws Exception {
  if(Looper.myLooper()==Looper.getMainLooper())throw new AssertionError("Contract must run on instrumentation worker");
  for(String origin:new String[]{"","http://localhost","https://user@localhost","https://localhost/path","https://localhost?query","https://localhost#fragment"}){
   try{new WebViewHealthObserver(origin,"true");throw new AssertionError("Invalid origin accepted");}catch(IllegalArgumentException expected){}
  }
  try{new WebViewHealthObserver("https://localhost"," ");throw new AssertionError("Empty policy accepted");}catch(IllegalArgumentException expected){}
  WebViewHealthObserver observer=new WebViewHealthObserver("https://localhost","true");
  JSONObject absent=observer.read(SystemClock.elapsedRealtime()+5000);
  if(!"absent".equals(absent.getString("activityState"))||absent.getBoolean("rendererResponsive")||absent.getBoolean("contentPresent"))throw new AssertionError("Absent view reported responsive");
  try{observer.read(SystemClock.elapsedRealtime()-1);throw new AssertionError("Expired request accepted");}catch(IOException expected){}
  CompletableFuture<Boolean> main=new CompletableFuture<>();
  new Handler(Looper.getMainLooper()).post(()->{try{observer.read(SystemClock.elapsedRealtime()+5000);main.complete(false);}catch(IOException expected){main.complete(true);}catch(Exception error){main.completeExceptionally(error);}});
  if(!main.get(5,TimeUnit.SECONDS))throw new AssertionError("Main thread blocked");
  try{observer.pause(null);throw new AssertionError("Off-main lifecycle accepted");}catch(IllegalStateException expected){}
 }
 private interface MainAction {void run()throws Exception;}
 private static void onMain(MainAction action)throws Exception{
  CompletableFuture<Void> done=new CompletableFuture<>();
  new Handler(Looper.getMainLooper()).post(()->{try{action.run();done.complete(null);}catch(Throwable error){done.completeExceptionally(error);}});
  done.get(10,TimeUnit.SECONDS);
 }
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static final class DeferredView extends WebView {
  final BlockingQueue<ValueCallback<String>> callbacks=new LinkedBlockingQueue<>();
  String url="https://localhost/one";
  DeferredView(Context context){super(context);}
  @Override public String getUrl(){return url;}
  @Override public boolean isShown(){return true;}
  @Override public boolean hasWindowFocus(){return true;}
  @Override public void evaluateJavascript(String source,ValueCallback<String> callback){callbacks.add(callback);}
 }
 private static final class Call {
  final Future<JSONObject> result;final ValueCallback<String> callback;
  Call(Future<JSONObject> result,ValueCallback<String> callback){this.result=result;this.callback=callback;}
 }
 private static Call issue(ExecutorService worker,WebViewHealthObserver observer,DeferredView view,long budget)throws Exception {
  Future<JSONObject> result=worker.submit(()->observer.read(SystemClock.elapsedRealtime()+budget));
  ValueCallback<String> callback=view.callbacks.poll(5,TimeUnit.SECONDS);
  check(callback!=null,"Evaluation was not issued");return new Call(result,callback);
 }
 private static void rejected(Future<JSONObject> result)throws Exception{
  try{result.get(3,TimeUnit.SECONDS);throw new AssertionError("Stale or invalid observation accepted");}
  catch(ExecutionException error){Throwable cause=error;while(cause instanceof ExecutionException&&cause.getCause()!=null)cause=cause.getCause();check(cause instanceof IOException||cause instanceof TimeoutException,"Unexpected observation failure: "+cause);}
 }
 public static void runLifecycle(Context context)throws Exception {
  Activity[] owner=new Activity[1];DeferredView[] views=new DeferredView[2];
  WebViewHealthObserver observer=new WebViewHealthObserver("https://localhost","true");
  ExecutorService worker=Executors.newFixedThreadPool(2);
  onMain(()->{owner[0]=new Activity();views[0]=new DeferredView(context);views[1]=new DeferredView(context);
   observer.resume(owner[0],views[0]);});
  try {
   Call old=issue(worker,observer,views[0],5000);
   rejected(worker.submit(()->observer.read(SystemClock.elapsedRealtime()+5000)));
   // The old renderer never replies before its replacement is attached to the same Activity.
   onMain(()->observer.resume(owner[0],views[1]));rejected(old.result);
   Call replacement=issue(worker,observer,views[1],5000);
   onMain(()->old.callback.onReceiveValue("true"));
   check(!replacement.result.isDone(),"Old renderer completed the replacement request");
   onMain(()->replacement.callback.onReceiveValue("false"));check(!replacement.result.get(3,TimeUnit.SECONDS).getBoolean("contentPresent"),"Replacement response lost");
   Call expired=issue(worker,observer,views[1],1000);rejected(expired.result);
   Call recovered=issue(worker,observer,views[1],5000);
   onMain(()->expired.callback.onReceiveValue("true"));check(!recovered.result.isDone(),"Expired callback completed a newer read");
   onMain(()->recovered.callback.onReceiveValue("true"));check(recovered.result.get(3,TimeUnit.SECONDS).getBoolean("contentPresent"),"Read after expiry failed");
   Call navigated=issue(worker,observer,views[1],5000);
   onMain(()->{views[1].url="https://localhost/two";navigated.callback.onReceiveValue("true");});rejected(navigated.result);
   Call paused=issue(worker,observer,views[1],5000);onMain(()->observer.pause(owner[0]));rejected(paused.result);
   check("background".equals(observer.read(SystemClock.elapsedRealtime()+5000).getString("activityState")),"Pause lost background state");
   onMain(()->observer.resume(owner[0],views[1]));Call resumed=issue(worker,observer,views[1],5000);
   onMain(()->paused.callback.onReceiveValue("true"));check(!resumed.result.isDone(),"Paused callback completed resumed read");
   onMain(()->resumed.callback.onReceiveValue("true"));check(resumed.result.get(3,TimeUnit.SECONDS).getBoolean("rendererResponsive"),"Resume did not recover");
   Call destroyed=issue(worker,observer,views[1],5000);onMain(()->observer.destroy(owner[0]));rejected(destroyed.result);
   onMain(()->destroyed.callback.onReceiveValue("true"));
   check("absent".equals(observer.read(SystemClock.elapsedRealtime()+5000).getString("activityState")),"Late callback revived destroyed owner");
   onMain(()->{for(boolean destroy:new boolean[]{false,true}){try{if(destroy)observer.destroy(null);else observer.pause(null);throw new AssertionError("Null lifecycle owner accepted");}catch(IllegalArgumentException expected){}}});
  }finally{worker.shutdownNow();onMain(()->{observer.destroy(owner[0]);for(DeferredView view:views)if(view!=null)view.destroy();});}
 }

}
