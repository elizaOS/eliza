package ai.eliza.plugins.agent.runtime;

import ai.eliza.plugins.agent.health.LocalRuntimeHealth;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import java.io.File;
import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONException;
import org.json.JSONObject;

/** Android lifecycle integration over the shared runtime session/group engines.
 * Hosts select commands, credentials, asset admission, routes and notification UI.
 * One live service is registered per concrete host class; requests bind once and
 * are never retargeted to replacement services or endpoints. */
public abstract class EmbeddedRuntimeService extends Service {
  public record Policy(long monitorMs,long restartDelayMs,int maxRestarts,
      int logBytes,int logLineBytes,long agentReadyMs,long gatewayReadyMs,long pollMs,int maxBodyBytes) {}
  @FunctionalInterface public interface EndpointRequest { JSONObject execute(int port,String token)throws Exception; }
  private static final ConcurrentHashMap<Class<?>,EmbeddedRuntimeService> current=new ConcurrentHashMap<>();
  private final Policy policy;
  private final NativeRuntimeSession supervisor;
  protected File root;
  protected EmbeddedRuntimeGroup group;

  protected EmbeddedRuntimeService(Policy policy) {
    if(policy==null || policy.maxBodyBytes()<=0)throw new IllegalArgumentException("Runtime service policy is required");
    this.policy=policy;
    supervisor=new NativeRuntimeSession(this::launch,policy.monitorMs(),policy.restartDelayMs(),policy.maxRestarts());
  }
  protected abstract File runtimeRootDirectory();
  protected abstract NotificationChannel runtimeNotificationChannel();
  protected abstract Notification runtimeNotification();
  protected abstract int runtimeNotificationId();
  protected abstract int runtimeForegroundType();
  protected abstract void launch(NativeRuntimeSession.Scope scope)throws Exception;

  protected static JSONObject statusFor(Class<? extends EmbeddedRuntimeService> type,boolean available,String startupFailure)throws JSONException {
    EmbeddedRuntimeService service=current.get(type);
    NativeProcessSupervisor.Snapshot state=service==null?null:service.supervisor.snapshot().lifecycle;
    JSONObject result=new JSONObject().put("available",available).put("onDevice",true)
      .put("state",available?(state==null?"stopped":state.state.name().toLowerCase(Locale.ROOT)):"unavailable");
    if(state!=null && state.failure!=null)result.put("error",state.failure instanceof IOException?state.failure.getMessage():startupFailure);
    if(service!=null)result.put("epoch",state.epoch);
    return result;
  }
  protected static JSONObject requestFor(Class<? extends EmbeddedRuntimeService> type,EndpointRequest request,String unavailable,String cancelled)throws Exception {
    EmbeddedRuntimeService service=current.get(type);
    NativeRuntimeSession.Snapshot binding=service==null?null:service.supervisor.snapshot();
    EmbeddedRuntimeGroup.Endpoint endpoint=service==null||service.group==null?null:service.group.gateway();
    if(endpoint==null)throw new IOException(unavailable);
    return service.supervisor.request(binding,()->current.get(type)==service,()->request.execute(endpoint.port,endpoint.token),unavailable,cancelled);
  }
  protected static void prepareRestartFor(Class<? extends EmbeddedRuntimeService> type) {
    EmbeddedRuntimeService service=current.get(type);
    if(service!=null)synchronized(service){if(current.get(type)==service)service.supervisor.invalidate();}
  }
  /** Off by default. A host returns true only in a test build (for example from a
   * test-only build flag) to admit {@link #injectChildExitFor}. Production builds keep false. */
  protected boolean allowsChildExitInjection(){return false;}
  /** Test-build fault hook: ends the named supervised child ("agent" or "gateway") of the
   * current running launch as a crash would, so instrumentation can observe the real
   * exit detection, restart policy and health reporting. Refused unless the live service
   * allows injection; returns false when it is not running or no live child has that name. */
  protected static boolean injectChildExitFor(Class<? extends EmbeddedRuntimeService> type,String name) {
    EmbeddedRuntimeService service=current.get(type);
    if(service==null)return false;
    if(!service.allowsChildExitInjection())throw new IllegalStateException("Runtime fault injection is disabled in this build");
    return service.supervisor.injectChildExit(name);
  }
  protected static LocalRuntimeHealth healthFor(Class<? extends EmbeddedRuntimeService> type,String processInstance,int timeoutMillis) {
    return new LocalRuntimeHealth(processInstance,()->{
      EmbeddedRuntimeService service=current.get(type);if(service==null)return null;
      NativeRuntimeSession.Snapshot binding=service.supervisor.snapshot();
      Process agent=binding.processes.get("agent"),gateway=binding.processes.get("gateway");
      NativeProcessSupervisor.Snapshot lifecycle=binding.lifecycle;
      return new LocalRuntimeHealth.Snapshot(service,binding.instance,lifecycle.state.name().toLowerCase(Locale.ROOT),lifecycle.epoch,
        lifecycle.state==NativeProcessSupervisor.State.STOPPED,agent,()->agent!=null&&agent.isAlive(),gateway,()->gateway!=null&&gateway.isAlive());
    },(snapshot,gateway,route,timeout)->((EmbeddedRuntimeService)snapshot.owner).exchange(gateway,route,timeout),timeoutMillis);
  }
  @Override public void onCreate() {
    super.onCreate();
    root=runtimeRootDirectory();
    NativeProcessLog log=new NativeProcessLog(new File(root,"agent.log").toPath(),policy.logBytes(),policy.logLineBytes());
    group=new EmbeddedRuntimeGroup(log,EmbeddedRuntimeLaunch.token(),
      (name,bytes)->writePrivate(new File(root,name),bytes),
      (endpoint,gateway)->exchangeHttp(endpoint.port,endpoint.token,"GET",gateway?"/health":"/api/status",null,1000,policy.maxBodyBytes()).getInt("status")==200,
      policy.agentReadyMs(),policy.gatewayReadyMs(),policy.pollMs());
    getSystemService(NotificationManager.class).createNotificationChannel(runtimeNotificationChannel());
    current.put(getClass(),this);
  }
  @Override public synchronized int onStartCommand(Intent intent,int flags,int startId) {
    String action=intent==null?null:intent.getAction();
    if("stop".equals(action)){stopSelf();return START_NOT_STICKY;}
    if(Build.VERSION.SDK_INT>=29)startForeground(runtimeNotificationId(),runtimeNotification(),runtimeForegroundType());
    else startForeground(runtimeNotificationId(),runtimeNotification());
    if("restart".equals(action))supervisor.restart();else supervisor.start();
    return START_NOT_STICKY;
  }
  protected static void writePrivate(File file,byte[] bytes)throws IOException {
    RuntimePrivateFiles.write(file.toPath(),bytes,AndroidRuntimeDirectories::syncRuntimeDirectory);
  }
  protected static JSONObject exchangeHttp(int port,String token,String method,String route,String body,int timeout,int maxBody)throws Exception {
    return LocalRuntimeHttp.exchange(port,token,method,route,body,timeout,maxBody,SystemClock::elapsedRealtimeNanos);
  }
  private JSONObject exchange(boolean gateway,String route,int timeout)throws Exception {
    EmbeddedRuntimeGroup.Endpoint endpoint=gateway?group.gateway():group.agent();
    if(endpoint==null)throw new IOException("Runtime endpoint is unavailable");
    return exchangeHttp(endpoint.port,endpoint.token,"GET",route,null,timeout,policy.maxBodyBytes());
  }
  @Override public synchronized void onDestroy() {
    try{supervisor.close();}
    finally{current.remove(getClass(),this);stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
  }
  @Override public void onTimeout(int startId,int foregroundServiceType){stopSelf();}
  @Override public IBinder onBind(Intent intent){return null;}
}
