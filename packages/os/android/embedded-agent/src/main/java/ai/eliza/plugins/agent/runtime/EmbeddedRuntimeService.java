package ai.eliza.plugins.agent.runtime;

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
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/** Android lifecycle integration over the shared runtime session/group engines.
 * Hosts select commands, credentials, asset admission, routes and notification UI.
 * One live service is registered per concrete host class; requests bind once and
 * are never retargeted to replacement services or endpoints. */
public abstract class EmbeddedRuntimeService extends Service {
  public record Policy(long monitorMs,long restartDelayMs,int maxRestarts,
      int logBytes,int logLineBytes,long agentReadyMs,long pollMs,int maxBodyBytes) {}
  @FunctionalInterface public interface EndpointRequest { JSONObject execute(EmbeddedRuntimeGroup.Endpoint endpoint) throws Exception; }
  private static final ConcurrentHashMap<Class<?>,EmbeddedRuntimeService> current=new ConcurrentHashMap<>();
  private static final ConcurrentHashMap<Class<?>,Set<Runnable>> observers=new ConcurrentHashMap<>();
  private static final ExecutorService changes=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"ElizaRuntimeStatus");t.setDaemon(true);return t;});
  private final Policy policy;
  private final NativeRuntimeSession supervisor;
  protected File root;
  protected EmbeddedRuntimeGroup group;

  protected EmbeddedRuntimeService(Policy policy) {
    if(policy==null || policy.maxBodyBytes()<=0)throw new IllegalArgumentException("Runtime service policy is required");
    this.policy=policy;
    supervisor=new NativeRuntimeSession(this::launch,policy.monitorMs(),policy.restartDelayMs(),policy.maxRestarts());
    supervisor.observe(()->changed(getClass()));
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
    if(available)result.put("requestBodyLimit",RuntimeRequestDispatcher.MAX_BODY_TEXT_UNITS);
    else result.put("failure","payload");
    if(state!=null && state.failure!=null){
      result.put("error",state.failure instanceof IOException?state.failure.getMessage():startupFailure);
      if(available)result.put("failure",RuntimeStartFailure.name(state.failure));
    }
    if(service!=null)result.put("epoch",state.epoch);
    return result;
  }
  protected static JSONObject requestFor(Class<? extends EmbeddedRuntimeService> type,EndpointRequest request,String unavailable,String cancelled)throws Exception {
    EmbeddedRuntimeService service=current.get(type);
    NativeRuntimeSession.Snapshot binding=service==null?null:service.supervisor.snapshot();
    EmbeddedRuntimeGroup.Endpoint endpoint=service==null||service.group==null?null:service.group.served();
    if(endpoint==null)throw new NativeRuntimeSession.NotReadyException(unavailable);
    return service.supervisor.request(binding,()->current.get(type)==service,()->request.execute(endpoint),unavailable,cancelled);
  }
  /** Runs the observer on a status thread after each lifecycle change of the host's service,
   * including its creation and destruction, until the returned handle is closed. */
  protected static AutoCloseable observeFor(Class<? extends EmbeddedRuntimeService> type,Runnable observer) {
    if(observer==null)throw new IllegalArgumentException("Runtime status observer is required");
    observers.computeIfAbsent(type,key->new CopyOnWriteArraySet<>()).add(observer);
    return ()->observers.getOrDefault(type,Set.of()).remove(observer);
  }
  private static void changed(Class<?> type) {
    for(Runnable observer:observers.getOrDefault(type,Set.of()))changes.execute(observer);
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
  @Override public void onCreate() {
    super.onCreate();
    root=runtimeRootDirectory();
    NativeProcessLog log=new NativeProcessLog(new File(root,"agent.log").toPath(),policy.logBytes(),policy.logLineBytes());
    group = new EmbeddedRuntimeGroup(log, endpoint -> {
      JSONObject response = LocalRuntimeSocket.exchange(endpoint.socket, endpoint.token, "GET", "/api/health", null, 1000);
      JSONObject health = response.getJSONObject("data");
      return response.getInt("status") == 200 && health.getBoolean("ready") && "ok".equals(health.getString("runtime"))
        && "running".equals(health.getString("agentState")) && health.getLong("epoch") == endpoint.epoch;
    }, policy.agentReadyMs(), policy.pollMs());
    getSystemService(NotificationManager.class).createNotificationChannel(runtimeNotificationChannel());
    current.put(getClass(),this);
    changed(getClass());
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
  @Override public synchronized void onDestroy() {
    try{supervisor.close();}
    finally{current.remove(getClass(),this);changed(getClass());stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
  }
  @Override public void onTimeout(int startId,int foregroundServiceType){stopSelf();}
  @Override public IBinder onBind(Intent intent){return null;}
}
