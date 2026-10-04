package ai.eliza.plugins.agent.health;
import android.app.Activity;
import android.net.Uri;
import android.os.*;
import android.webkit.WebView;
import java.lang.ref.WeakReference;
import java.io.IOException;
import java.util.concurrent.*;
import org.json.JSONObject;
/** Read-only foreground DOM observations. Never launches/resumes an activity.
 * DOM presence is not visual/usability acceptance or a complete healthy verdict. */
public final class WebViewHealthObserver {
 private final Uri origin;
 private final String script;
 public WebViewHealthObserver(String trustedOrigin,String observationScript) {
  origin=Uri.parse(trustedOrigin==null?"":trustedOrigin);
  if(!"https".equals(origin.getScheme())||origin.getHost()==null||origin.getUserInfo()!=null||!"".equals(origin.getPath())||origin.getQuery()!=null||origin.getFragment()!=null||observationScript==null||observationScript.trim().isEmpty())throw new IllegalArgumentException("Explicit HTTPS origin and host observation script required");
  script="(()=>{if(location.origin!=="+JSONObject.quote(trustedOrigin)+")return false;const visible=e=>{if(!e)return false;for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};return ("+observationScript+");})()";
 }
 private static void requireMain(){if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("Lifecycle observation requires main thread");}
 private WeakReference<WebView> renderer=new WeakReference<>(null);
 private final Handler main=new Handler(Looper.getMainLooper());
 private WeakReference<Activity> current=new WeakReference<>(null);
 private boolean resumed;
 private long generation;
 private static final class Request {
  final long deadline;final CompletableFuture<JSONObject> result;
  Request(long deadline,CompletableFuture<JSONObject> result){this.deadline=deadline;this.result=result;}
 }
 private Request pending;
 private void retirePending(String reason){Request old=pending;pending=null;if(old!=null)old.result.completeExceptionally(new IOException(reason));}
 public void resume(Activity activity,WebView view){requireMain();if(activity==null||view==null)throw new IllegalArgumentException("Activity and renderer required");retirePending("UI lifecycle changed during observation");renderer=new WeakReference<>(view);current=new WeakReference<>(activity);resumed=true;generation++;}
 public void pause(Activity activity){requireMain();if(activity==null)throw new IllegalArgumentException("Activity required");if(current.get()==activity){retirePending("UI paused during observation");resumed=false;generation++;}}
 public void destroy(Activity activity){requireMain();if(activity==null)throw new IllegalArgumentException("Activity required");if(current.get()==activity){retirePending("UI destroyed during observation");current.clear();renderer.clear();resumed=false;generation++;}}
 public JSONObject read(long deadline)throws Exception {
  if(Looper.myLooper()==Looper.getMainLooper())throw new IOException("UI probe cannot block main thread");
  CompletableFuture<JSONObject> result=new CompletableFuture<>();
  main.post(()->{
   try{
    if(SystemClock.elapsedRealtime()>=deadline)throw new IOException("UI observation expired");
    Activity activity=current.get();
    if(activity==null){result.complete(value("absent",false,false));return;}
    WebView view=renderer.get();
    if(view==null||!resumed||activity.isFinishing()||activity.isDestroyed()||!view.isShown()||!view.hasWindowFocus()){
     result.complete(value("background",false,false));return;
    }
    if(pending!=null&&SystemClock.elapsedRealtime()>=pending.deadline)retirePending("UI observation expired");
    if(pending!=null)throw new IOException("Renderer observation already pending");
    long ticket=generation;
    String observedUrl=view.getUrl();
    android.net.Uri uri=android.net.Uri.parse(observedUrl==null?"":observedUrl);
    if(!origin.getScheme().equals(uri.getScheme())||!origin.getEncodedAuthority().equals(uri.getEncodedAuthority()))throw new IOException("Unexpected renderer origin");
    Request request=new Request(deadline,result);pending=request;
    try { view.evaluateJavascript(script,answer->{
     try{
      if(pending!=request||SystemClock.elapsedRealtime()>=deadline||generation!=ticket||current.get()!=activity||renderer.get()!=view||!resumed||!view.hasWindowFocus()||!java.util.Objects.equals(observedUrl,view.getUrl()))throw new IOException("UI changed during observation");
      if(!"true".equals(answer)&&!"false".equals(answer))throw new IOException("Invalid renderer response");
      result.complete(value("foreground",true,"true".equals(answer)));
     }catch(Exception error){result.completeExceptionally(error);}finally{if(pending==request)pending=null;}
    }); } catch(Exception error) {if(pending==request)pending=null;throw error;}
   }catch(Exception error){result.completeExceptionally(error);}
  });
  try{
   long remaining=deadline-SystemClock.elapsedRealtime();if(remaining<=0)throw new IOException("UI observation expired");
   return result.get(remaining,TimeUnit.MILLISECONDS);
  }finally{
   // WebView cannot cancel an issued evaluation. Retire its logical lease on
   // timeout/interruption; any eventual callback is fenced from newer reads.
   main.post(()->{if(pending!=null&&pending.result==result)retirePending("UI observation ended");});
  }
 }
 private static JSONObject value(String state,boolean responsive,boolean content)throws Exception{return new JSONObject().put("activityState",state).put("rendererResponsive",responsive).put("contentPresent",content);}
}
