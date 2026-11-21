// spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"; spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"; spec/os/agentService/lifecycle.md, "Story: Restart a crashed or unhealthy agent within a budget"; spec/os/agentService/lifecycle.md, "Story: Recover my agent's records after a storage failure"; spec/os/agentService/lifecycle.md, "Story: Hold the agent for an app update"; spec/os/agentService/lifecycle.md, "Story: Hand a new device key of the same account to the running agent"; spec/os/agentService/health.md, "Story: Tell a busy agent from an absent one"; spec/os/agentService/config.md, "Story: Start my agent with my character, policy and model"
package ai.eliza.os.agent;

import ai.eliza.os.agent.AgentPolicy.Effect;
import ai.eliza.os.agent.AgentPolicy.Phase;
import ai.eliza.os.agent.ChannelPolicy.CallerKind;
import ai.eliza.os.agent.ChannelPolicy.Topic;
import ai.eliza.plugins.agent.runtime.AndroidRuntimeDirectories;
import android.app.ActivityManager;
import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.json.JSONException;
import org.json.JSONObject;

public class AgentService extends Service {
  public static final String ACTION_START = "ai.eliza.os.agent.action.START";
  public static final String ACTION_RESTART = "ai.eliza.os.agent.action.RESTART";
  public static final String ACTION_STOP = "ai.eliza.os.agent.action.STOP";
  private static final String TAG = "ElizaAgent";
  private static final String NOTIFICATION_CHANNEL = "eliza-agent";
  private static final int NOTIFICATION_ID = 7301;
  private static final long CALL_TIMEOUT_MS = 30_000L;
  private static final String HEALTH = "/api/health";
  private static final String STATUS = "/api/status";
  private static final String AWAITING_KEY = "agent-awaiting-key";
  private static final Pattern VARIABLE = Pattern.compile("[A-Z][A-Z0-9_]*");
  private static final Pattern RESERVED = Pattern.compile("(ELIZA_AGENT_|ELIZA_CLOUD_|ELIZA_OWN_|LD_|NODE_).*|PATH|HOME|TMPDIR");
  private static final Object LOCK = new Object();
  private static final AgentChannel CHANNEL = new AgentChannel(new ChannelPolicy(), AgentSocketClient.android());
  private static final Set<Runnable> observers = new CopyOnWriteArraySet<>();
  private static final Set<Runnable> readyObservers = new CopyOnWriteArraySet<>();
  private static final ExecutorService notices = daemonSingle("ElizaAgentNotices");
  private static volatile AgentService live;
  private static volatile AgentConfig loaded;
  private static volatile AgentCredentials registered = AgentCredentials.NONE;

  public record Review(String token, int retainedCount) {}

  public static final class LaunchRefused extends Exception {
    public LaunchRefused(String reason) { super(reason); }
  }

  private final ScheduledThreadPoolExecutor effects = effectExecutor();
  private final ExecutorService work = Executors.newCachedThreadPool(task -> daemon(task, "ElizaAgentWork"));
  private final AgentSocketClient client = AgentSocketClient.android();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Map<String, AgentCredentials.Account> accounts = new HashMap<>();
  private final List<ScheduledFuture<?>> timers = new ArrayList<>();
  private volatile AgentPolicy policy = new AgentPolicy(null);
  private volatile long base;
  private volatile int lastStartId;
  private boolean foreground;
  private String initFailure;
  private AgentDirectories directories;
  private ChildJournal journal;
  private UpdateHold hold;
  private AgentSupervisor.Child child;
  private String token;
  private Path socket;
  private CompletableFuture<Review> review;
  private int archived = -1;
  private volatile long bodyLimit;
  private Boolean awaitingWritten;

  public static void useCredentials(AgentCredentials source) { registered = Objects.requireNonNull(source); }

  protected AgentCredentials credentials() { return registered; }

  protected void configureLaunch(Map<String, String> variables) throws LaunchRefused { }

  protected NotificationChannel runtimeNotificationChannel() {
    return new NotificationChannel(NOTIFICATION_CHANNEL, words().channel(), NotificationManager.IMPORTANCE_LOW);
  }

  protected Notification runtimeNotification() {
    AgentConfig.Notification words = words();
    Notification.Builder builder = new Notification.Builder(this, NOTIFICATION_CHANNEL).setSmallIcon(getApplicationInfo().icon)
      .setContentTitle(words.title()).setContentText(words.text()).setOngoing(true);
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (open != null) builder.setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE));
    return builder.build();
  }

  protected final Notification.Action stopAction(CharSequence label) {
    PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, getClass()).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Action.Builder(null, label, stop).build();
  }

  public static AgentChannel channel() { return CHANNEL; }

  public static CompletableFuture<AgentChannel.Response> request(String method, String path, byte[] body) {
    return CHANNEL.request(CallerKind.NATIVE, method, path, body);
  }

  public static AgentChannel.Call requestStream(String method, String path, byte[] body, AgentChannel.Listener listener) {
    return CHANNEL.requestStream(CallerKind.NATIVE, method, path, body, listener);
  }

  public static AgentChannel.Call subscribe(Topic topic, AgentChannel.Listener listener) { return CHANNEL.subscribe(topic, listener); }

  public static AutoCloseable observe(Runnable observer) {
    observers.add(Objects.requireNonNull(observer));
    return () -> observers.remove(observer);
  }

  public static AutoCloseable onReady(Runnable observer) {
    readyObservers.add(Objects.requireNonNull(observer));
    AgentService service = live;
    if (service != null && service.policy.state().phase() == Phase.RUNNING) notices.execute(observer);
    return () -> readyObservers.remove(observer);
  }

  public static JSONObject status(Context context) {
    AgentService service = live;
    if (service == null && !declared(context)) {
      try { return new JSONObject().put("available", false).put("state", "unavailable").put("epoch", 0).put("requestBodyLimit", 0); }
      catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }
    AgentPolicy.Status status = service == null ? new AgentPolicy(null).status(0)
      : service.policy.status(service.policy.state().phase() == Phase.RUNNING ? service.bodyLimit : 0);
    try {
      JSONObject out = new JSONObject().put("available", status.available()).put("state", status.state())
        .put("epoch", service == null ? 0 : service.base + status.epoch()).put("requestBodyLimit", status.requestBodyLimit());
      if (status.failure() != null) out.put("failure", status.failure());
      if (status.error() != null) out.put("error", status.error());
      return out;
    } catch (JSONException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  public static void start(Context context) { command(context, ACTION_START); }

  public static void restart(Context context) { command(context, ACTION_RESTART); }

  public static void stop(Context context) {
    AgentService service = live;
    if (service != null) service.post(new AgentPolicy.Stop());
  }

  public static void credentialChanged(Context context) {
    AgentService service = live;
    if (service != null) {
      service.later(() -> service.settled(service::syncCredential));
      return;
    }
    if (!Files.exists(awaitingKey(context), LinkOption.NOFOLLOW_LINKS) || !signedIn()) return;
    try { start(context); }
    catch (IllegalStateException refused) { Log.w(TAG, "The agent was not started for the arriving device key", refused); }
  }

  static void awaitKey(Context context) {
    try { markAwaitingKey(context, true); }
    catch (IOException failed) { Log.w(TAG, "The wait for a device key could not be recorded", failed); }
  }

  static boolean signedIn() {
    try { return registered == AgentCredentials.NONE || registered.current() != null; }
    catch (Exception unreadable) {
      Log.w(TAG, "The device credential could not be read", unreadable);
      return false;
    }
  }

  public static Review reviewRecovery(Context context) {
    AgentService service = live;
    if (service == null) return null;
    ActivityManager.RunningAppProcessInfo process = new ActivityManager.RunningAppProcessInfo();
    ActivityManager.getMyMemoryState(process);
    boolean focused = process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    String nonce = LaunchFrame.newToken();
    try {
      return service.call(() -> {
        service.review = new CompletableFuture<>();
        service.step(new AgentPolicy.ReviewRecovery(focused, nonce));
        CompletableFuture<Review> answer = service.review;
        service.review = null;
        return answer.getNow(null);
      });
    } catch (IOException failed) {
      Log.w(TAG, "The recovery review did not complete", failed);
      return null;
    }
  }

  public static int archiveRecovery(Context context, String reviewToken) {
    AgentService service = live;
    int dot = reviewToken == null ? -1 : reviewToken.indexOf('.');
    if (service == null || dot < 1 || !reviewToken.substring(0, dot).matches("[0-9]{1,18}")) return -1;
    AgentPolicy.RecoveryToken token = new AgentPolicy.RecoveryToken(Long.parseLong(reviewToken.substring(0, dot)), reviewToken.substring(dot + 1));
    try {
      return service.call(() -> {
        service.archived = -1;
        service.settled(() -> service.step(new AgentPolicy.ArchiveRecovery(token)));
        return service.archived;
      });
    } catch (IOException failed) {
      Log.w(TAG, "The recovery archive did not complete", failed);
      return -1;
    }
  }

  static boolean holdForUpdate(Context context, AgentPolicy.UpdateTarget target) throws IOException {
    AgentService service;
    synchronized (LOCK) {
      service = live;
      if (service == null) {
        UpdateHold store = UpdateHold.of(context);
        AgentPolicy.UpdateTarget held = store.held();
        if (target.equals(held)) return true;
        if (!new AgentPolicy(held).step(new AgentPolicy.HoldForUpdate(target)).accepted()) return false;
        store.save(target);
        return true;
      }
    }
    return service.call(() -> {
      boolean[] taken = new boolean[1];
      service.settled(() -> {
        try { taken[0] = service.hold(target); }
        catch (IOException failed) { throw new IllegalStateException(failed); }
      });
      return taken[0];
    });
  }

  static boolean releaseUpdate(Context context, long installedCode, String installedDigest, boolean attemptEnded) throws IOException {
    AgentPolicy.ReleaseUpdate release = new AgentPolicy.ReleaseUpdate(installedCode, installedDigest, attemptEnded);
    AgentService service;
    synchronized (LOCK) {
      service = live;
      if (service == null) {
        UpdateHold store = UpdateHold.of(context);
        if (!new AgentPolicy(store.held()).step(release).accepted()) return false;
        store.save(null);
        return true;
      }
    }
    return service.call(() -> {
      UpdateHold store = service.holdStore();
      if (!service.step(release).accepted()) return false;
      store.save(null);
      return true;
    });
  }

  public static AgentConfig config(Context context) throws AgentConfig.Refused, IOException {
    AgentConfig config = loaded;
    if (config != null) return config;
    config = AgentConfig.parse(asset(context, AgentConfig.HOST_ASSET), asset(context, AgentConfig.CHARACTER_ASSET), asset(context, AgentConfig.POLICY_ASSET));
    loaded = config;
    return config;
  }

  @Override public void onCreate() {
    super.onCreate();
    getSystemService(NotificationManager.class).createNotificationChannel(runtimeNotificationChannel());
    if (!showForeground()) {
      stopSelf();
      return;
    }
    synchronized (LOCK) {
      AgentPolicy.UpdateTarget held = null;
      try {
        directories = new AgentDirectories(getFilesDir().toPath(), AndroidRuntimeDirectories::syncRuntimeDirectory);
        journal = new ChildJournal(directories.journal(), new ChildJournal.AndroidProcesses(), directories.sync());
        hold = UpdateHold.of(this);
        base = journal.lastEpoch();
        held = hold.held();
      } catch (IOException | RuntimeException unreadable) {
        initFailure = "The agent's private storage could not be read: " + unreadable.getMessage();
        Log.e(TAG, initFailure, unreadable);
      }
      policy = new AgentPolicy(held);
      live = this;
    }
    later(() -> settled(this::syncCredential));
    changed();
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    lastStartId = startId;
    if (intent != null && ACTION_STOP.equals(intent.getAction())) {
      post(new AgentPolicy.Stop());
      return START_NOT_STICKY;
    }
    if (!foreground && !showForeground()) {
      stopSelfResult(startId);
      return START_NOT_STICKY;
    }
    if (intent != null && ACTION_RESTART.equals(intent.getAction())) post(new AgentPolicy.Stop(), new AgentPolicy.Start());
    else post(new AgentPolicy.Start());
    return START_STICKY;
  }

  @Override public void onDestroy() {
    synchronized (LOCK) { if (live == this) live = null; }
    later(() -> {
      cancelTimers();
      if (child != null) {
        CHANNEL.retire(child.epoch);
        child.kill();
        child = null;
      }
    });
    effects.shutdown();
    work.shutdown();
    changed();
    super.onDestroy();
  }

  @Override public IBinder onBind(Intent intent) { return null; }

  private static boolean declared(Context context) {
    try {
      context.getPackageManager().getServiceInfo(new ComponentName(context, config(context).service), 0);
      return true;
    } catch (AgentConfig.Refused | IOException | PackageManager.NameNotFoundException absent) {
      return false;
    }
  }

  private static Path awaitingKey(Context context) { return context.getNoBackupFilesDir().toPath().resolve(AWAITING_KEY); }

  private static void markAwaitingKey(Context context, boolean awaiting) throws IOException {
    Path marker = awaitingKey(context);
    if (awaiting) Files.write(marker, new byte[0], StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.SYNC);
    else Files.deleteIfExists(marker);
  }

  private static void command(Context context, String action) {
    Class<? extends AgentService> type;
    try { type = Class.forName(config(context).service, true, context.getClassLoader()).asSubclass(AgentService.class); }
    catch (AgentConfig.Refused | IOException | ClassNotFoundException | ClassCastException missing) {
      throw new IllegalStateException("The agent service is not configured in this build: " + missing.getMessage(), missing);
    }
    context.startForegroundService(new Intent(context, type).setAction(action));
  }

  private static byte[] asset(Context context, String name) throws IOException {
    try (InputStream input = context.getAssets().open(name)) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      for (int read; (read = input.read(buffer)) >= 0 && bytes.size() <= AgentConfig.MAX_FILE_BYTES;) bytes.write(buffer, 0, read);
      return bytes.toByteArray();
    } catch (FileNotFoundException missing) {
      return null;
    }
  }

  private AgentConfig.Notification words() {
    try { return config(this).notification; }
    catch (AgentConfig.Refused | IOException unreadable) {
      String label = getApplicationInfo().loadLabel(getPackageManager()).toString();
      return new AgentConfig.Notification(label, label, "");
    }
  }

  private boolean showForeground() {
    try {
      int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST;
      startForeground(NOTIFICATION_ID, runtimeNotification(), type);
      foreground = true;
      return true;
    } catch (IllegalStateException refused) {
      if (Build.VERSION.SDK_INT < 31 || !(refused instanceof ForegroundServiceStartNotAllowedException)) throw refused;
      Log.w(TAG, "Android refused to start the agent in the foreground", refused);
      return false;
    }
  }

  private void post(AgentPolicy.Event... events) {
    later(() -> settled(() -> { for (AgentPolicy.Event event : events) step(event); }));
  }

  private void later(Runnable task) {
    try { effects.execute(task); }
    catch (RejectedExecutionException closed) { Log.d(TAG, "The agent service has ended and takes no more work"); }
  }

  private <T> T call(Callable<T> task) throws IOException {
    try { return effects.submit(task).get(CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS); }
    catch (ExecutionException failed) {
      Throwable cause = failed.getCause() instanceof IllegalStateException state && state.getCause() instanceof IOException io ? io : failed.getCause();
      if (cause instanceof IOException io) throw io;
      throw new IOException("The agent service could not carry out the request", cause);
    } catch (TimeoutException | InterruptedException | RejectedExecutionException unanswered) {
      if (unanswered instanceof InterruptedException) Thread.currentThread().interrupt();
      throw new IOException("The agent service did not answer", unanswered);
    }
  }

  private void offload(Runnable task) {
    try { work.execute(task); }
    catch (RejectedExecutionException closed) { Log.d(TAG, "The agent service has ended and runs no more checks"); }
  }

  private void settled(Runnable steps) {
    steps.run();
    AgentPolicy.State state = policy.state();
    boolean awaiting = state.phase() == Phase.FAILED && state.failure() == AgentPolicy.Cause.CREDENTIAL;
    if (!Boolean.valueOf(awaiting).equals(awaitingWritten)) {
      try {
        markAwaitingKey(this, awaiting);
        awaitingWritten = awaiting;
      } catch (IOException failed) {
        Log.w(TAG, "The wait for a device key could not be recorded", failed);
      }
    }
    boolean stopped = state.phase() == Phase.STOPPED;
    int startId = lastStartId;
    main.post(() -> {
      if (stopped && foreground) {
        stopForeground(STOP_FOREGROUND_REMOVE);
        foreground = false;
        stopSelfResult(startId);
      } else if (!stopped && !foreground) {
        showForeground();
      }
    });
  }

  private AgentPolicy.Step step(AgentPolicy.Event event) {
    AgentPolicy.Step step = policy.step(event);
    if (!step.accepted()) return step;
    for (Effect effect : step.effects()) carryOut(effect);
    changed();
    return step;
  }

  private void carryOut(Effect effect) {
    if (effect instanceof AgentPolicy.Check check) effects.schedule(() -> settled(() -> check(check)), check.delayMs(), TimeUnit.MILLISECONDS);
    else if (effect instanceof AgentPolicy.Kill kill) {
      cancelTimers();
      AgentSupervisor.Child target = child;
      if (target != null && target.epoch == base + kill.epoch()) work.execute(target::stop);
    } else if (effect instanceof AgentPolicy.PushCredential push) push(push);
    else if (effect instanceof AgentPolicy.RecoveryReview recovery) {
      if (review != null) review.complete(new Review(recovery.token().token() + "." + recovery.token().nonce(), retained()));
    } else archive((AgentPolicy.Archive) effect);
  }

  private boolean checking(long launch) {
    AgentPolicy.State state = policy.state();
    return state.phase() == Phase.CHECKING && state.epoch() == launch;
  }

  private void check(AgentPolicy.Check check) {
    long launch = check.epoch();
    if (!checking(launch)) return;
    if (initFailure != null) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.RUNTIME, initFailure));
      return;
    }
    offload(() -> {
      String failure = null;
      try { journal.reapStale(base + launch); }
      catch (IOException failed) { failure = "The previous agent could not be ended: " + failed.getMessage(); }
      String reapFailure = failure;
      later(() -> settled(() -> reaped(launch, reapFailure)));
    });
  }

  private void reaped(long launch, String failure) {
    if (!checking(launch)) return;
    if (failure != null) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.RUNTIME, failure));
      return;
    }
    if (policy.state().child() instanceof AgentPolicy.Stale) step(new AgentPolicy.ReapStale());
    AgentConfig config;
    try { config = config(this); }
    catch (AgentConfig.Refused | IOException refused) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.CONFIG, refused.getMessage()));
      return;
    }
    List<RouteGate.Group> nativeRoutes = config.routes(CallerKind.NATIVE);
    boolean rendererLoaded = CHANNEL.policy().loadRoutes(CallerKind.RENDERER, config.routes(CallerKind.RENDERER));
    boolean nativeLoaded = CHANNEL.policy().loadRoutes(CallerKind.NATIVE, nativeRoutes);
    if (!rendererLoaded || (!nativeLoaded && !nativeRoutes.isEmpty())) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.CONFIG, "The agent's route lists could not be loaded"));
      return;
    }
    offload(() -> {
      PayloadCheck.Check payload = null;
      String verifyFailure = null;
      try {
        payload = PayloadCheck.prepare(name -> getAssets().open(name), versionCode(), List.of(Build.SUPPORTED_ABIS),
          Paths.get(getApplicationInfo().nativeLibraryDir), directories.runtime(), directories.sync());
      } catch (IOException | PackageManager.NameNotFoundException | RuntimeException failed) {
        verifyFailure = "The agent runtime could not be verified: " + failed.getMessage();
      }
      PayloadCheck.Check checked = payload;
      String prepareFailure = verifyFailure;
      later(() -> settled(() -> prepared(launch, config, checked, prepareFailure)));
    });
  }

  private void prepared(long launch, AgentConfig config, PayloadCheck.Check payload, String failure) {
    if (!checking(launch)) return;
    if (failure != null || payload instanceof PayloadCheck.Failed) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.PAYLOAD, failure != null ? failure : String.join("; ", ((PayloadCheck.Failed) payload).errors())));
      return;
    }
    PayloadCheck.PreparedPayload prepared = ((PayloadCheck.Ready) payload).payload();
    AgentCredentials.Active active;
    String storageKey;
    try {
      active = currentKey();
      storageKey = active == null ? null : credentials().storageKey(active.account());
    } catch (Exception unreadable) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.RUNTIME, "The device credential could not be read: " + unreadable.getMessage()));
      return;
    }
    sync(active);
    if (!checking(launch)) return;
    Map<String, String> variables = new LinkedHashMap<>();
    String document = null;
    String refusal = null;
    try {
      configureLaunch(variables);
      document = launchDocument(config, active == null ? null : active.account(), prepared.workflowWorker(), variables);
    } catch (LaunchRefused | IllegalArgumentException refused) {
      refusal = refused.getMessage();
    }
    if (!step(new AgentPolicy.LaunchHook(refusal != null, refusal)).accepted() || !checking(launch)) return;
    if (active == null) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.CREDENTIAL, "no device credential is held"));
      return;
    }
    Path stateDir;
    try { stateDir = directories.state(active.account().userId(), active.account().organizationId()); }
    catch (IOException failed) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.STORAGE, "The agent's state directory is not usable: " + failed.getMessage()));
      return;
    }
    long epoch = base + launch;
    String launchToken = LaunchFrame.newToken();
    String launchDocument = document;
    AgentCredentials.Active key = active;
    offload(() -> {
      AgentSupervisor.Child spawned = null;
      Path agentSocket = null;
      String spawnFailure = null;
      try {
        byte[] frame = LaunchFrame.first(launchToken, epoch, LaunchFrame.Credential.of(key), storageKey).encode();
        Path launchFile = writeLaunch(launchDocument);
        agentSocket = directories.prepareSocket();
        AgentSupervisor.Command command = new AgentSupervisor.Command(prepared.node(), prepared.bundleDir(), launchFile, stateDir, agentSocket,
          directories.runtime().resolve("agent.log"));
        spawned = AgentSupervisor.spawn(epoch, command, frame, (spawnedEpoch, pid) -> journal.record(Math.toIntExact(pid), spawnedEpoch));
      } catch (IOException | RuntimeException failed) {
        spawnFailure = "The agent could not be started: " + failed.getMessage();
      }
      AgentSupervisor.Child started = spawned;
      Path startedSocket = agentSocket;
      String startFailure = spawnFailure;
      later(() -> settled(() -> spawned(launch, launchToken, startedSocket, started, startFailure)));
    });
  }

  private void spawned(long launch, String launchToken, Path agentSocket, AgentSupervisor.Child spawned, String failure) {
    if (spawned == null) {
      if (checking(launch)) step(new AgentPolicy.SpawnFailed(failure));
      return;
    }
    if (!checking(launch)) {
      discard(spawned);
      return;
    }
    child = spawned;
    token = launchToken;
    socket = agentSocket;
    if (!step(new AgentPolicy.Spawned()).accepted()) {
      child = null;
      token = null;
      socket = null;
      discard(spawned);
      return;
    }
    spawned.watch(readyEpoch -> HealthPolicy.classify(probe(agentSocket, launchToken, () -> true), readyEpoch) == HealthPolicy.Probe.OK,
      new AgentSupervisor.Listener() {
        @Override public void ready(long readyEpoch) { later(() -> settled(() -> ready(readyEpoch))); }
        @Override public void readinessTimedOut(long timedOut) { later(() -> settled(() -> { if (owns(timedOut)) step(new AgentPolicy.ReadyTimeout("The agent did not answer ready within " + AgentPolicy.READY_TIMEOUT_MS / 1000 + " s")); })); }
        @Override public void exited(long exitedEpoch, int code) { later(() -> settled(() -> exited(exitedEpoch, code))); }
      });
  }

  private void discard(AgentSupervisor.Child spawned) {
    offload(() -> {
      spawned.stop();
      try { journal.clear(spawned.epoch); }
      catch (IOException failed) { Log.w(TAG, "The discarded agent child stays journaled until it is reaped", failed); }
    });
  }

  private boolean owns(long launchEpoch) { return child != null && child.epoch == launchEpoch; }

  private void ready(long launchEpoch) {
    if (!owns(launchEpoch) || policy.state().phase() != Phase.SPAWNED) return;
    Path agentSocket = socket;
    String launchToken = token;
    offload(() -> {
      long limit = requestBodyLimit(agentSocket, launchToken);
      later(() -> settled(() -> serve(launchEpoch, limit)));
    });
  }

  private void serve(long launchEpoch, long limit) {
    if (!owns(launchEpoch) || policy.state().phase() != Phase.SPAWNED) return;
    if (limit <= 0) {
      step(new AgentPolicy.ReadyTimeout("The agent did not report its request body limit"));
      return;
    }
    if (!CHANNEL.open(launchEpoch, token, socket)) {
      step(new AgentPolicy.ReadyTimeout("The agent channel could not be opened for launch " + launchEpoch));
      return;
    }
    bodyLimit = limit;
    if (!step(new AgentPolicy.ObserveReady(launchEpoch - base)).accepted()) {
      CHANNEL.retire(launchEpoch);
      return;
    }
    timers.add(effects.scheduleWithFixedDelay(() -> health(launchEpoch, true), HealthPolicy.PROBE_INTERVAL_MS, HealthPolicy.PROBE_INTERVAL_MS, TimeUnit.MILLISECONDS));
    timers.add(effects.scheduleWithFixedDelay(() -> health(launchEpoch, false), HealthPolicy.CONNECT_CHECK_INTERVAL_MS, HealthPolicy.CONNECT_CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS));
    timers.add(effects.schedule(() -> settled(() -> { if (owns(launchEpoch)) step(new AgentPolicy.StableReset()); }), HealthPolicy.STABLE_RUN_MS, TimeUnit.MILLISECONDS));
    for (Runnable observer : readyObservers) notices.execute(observer);
  }

  private void exited(long launchEpoch, int code) {
    if (!owns(launchEpoch)) return;
    child = null;
    token = null;
    cancelTimers();
    CHANNEL.retire(launchEpoch);
    try { journal.clear(launchEpoch); }
    catch (IOException failed) { Log.e(TAG, "The agent child journal could not be cleared", failed); }
    Log.i(TAG, "The agent of epoch " + launchEpoch + " exited with code " + code);
    step(new AgentPolicy.ObserveExit(code));
  }

  private void health(long launchEpoch, boolean probe) {
    AgentSupervisor.Child running = child;
    Path agentSocket = socket;
    String launchToken = token;
    if (!owns(launchEpoch) || policy.state().phase() != Phase.RUNNING) return;
    work.execute(() -> {
      HealthPolicy.Observation seen;
      if (probe) seen = new HealthPolicy.Probed(probe(agentSocket, launchToken, running::alive));
      else {
        ChildJournal.Child observed;
        try { observed = journal.observe(); }
        catch (IOException unreadable) {
          Log.w(TAG, "The agent child journal could not be read", unreadable);
          return;
        }
        HealthPolicy.JournaledChild journaled = observed instanceof ChildJournal.Journaled entry ? new HealthPolicy.JournaledChild(entry.childEpoch(), entry.alive()) : null;
        seen = new HealthPolicy.ConnectChecked(!accepts(agentSocket), journaled);
      }
      later(() -> settled(() -> {
        if (!owns(launchEpoch) || policy.state().phase() != Phase.RUNNING) return;
        if (!step(new AgentPolicy.ObserveHealth(seen)).accepted()) step(new AgentPolicy.RestartUnhealthy(seen));
      }));
    });
  }

  private AgentSocketClient.Result get(Path agentSocket, String launchToken, String path, AtomicBoolean connected) {
    AtomicReference<AgentSocketClient.Result> answer = new AtomicReference<>();
    try {
      client.exchange(agentSocket, launchToken, path.substring(5) + "-" + UUID.randomUUID(), new AgentSocketClient.HttpCall("GET", path, null, false),
        link -> connected.set(true), frame -> {
          if (frame instanceof AgentSocketClient.Result result) answer.set(result);
          return false;
        });
    } catch (IOException | RuntimeException unanswered) {
      Log.d(TAG, "The agent did not answer " + path + ": " + unanswered.getMessage());
    }
    return answer.get();
  }

  private HealthPolicy.ProbeReply probe(Path agentSocket, String launchToken, BooleanSupplier alive) {
    AtomicBoolean connected = new AtomicBoolean();
    AgentSocketClient.Result result = get(agentSocket, launchToken, HEALTH, connected);
    if (result == null) return new HealthPolicy.Unanswered(alive.getAsBoolean(), connected.get());
    HealthPolicy.HealthBody body;
    try {
      JSONObject health = new JSONObject(new String(result.body(), StandardCharsets.UTF_8));
      body = new HealthPolicy.HealthBody(health.optBoolean("ready"), health.optString("runtime", null), health.optString("agentState", null), health.optLong("epoch", -1));
    } catch (JSONException malformed) {
      body = null;
    }
    return new HealthPolicy.Answered(result.status(), body);
  }

  private long requestBodyLimit(Path agentSocket, String launchToken) {
    AgentSocketClient.Result result = get(agentSocket, launchToken, STATUS, new AtomicBoolean());
    if (result == null || result.status() != 200) return 0;
    try { return new JSONObject(new String(result.body(), StandardCharsets.UTF_8)).optLong("requestBodyLimit", 0); }
    catch (JSONException malformed) { return 0; }
  }

  private static boolean accepts(Path agentSocket) {
    if (agentSocket == null) return false;
    try (LocalSocket probe = new LocalSocket()) {
      probe.connect(new LocalSocketAddress(agentSocket.toString(), LocalSocketAddress.Namespace.FILESYSTEM));
      return true;
    } catch (IOException refused) {
      return false;
    }
  }

  private AgentCredentials.Active currentKey() throws Exception {
    try { return credentials().current(); }
    catch (IllegalArgumentException unnamed) {
      Log.w(TAG, "The device credential names no usable account", unnamed);
      return null;
    }
  }

  private void syncCredential() {
    try { sync(currentKey()); }
    catch (Exception unreadable) { Log.w(TAG, "The device credential could not be read", unreadable); }
  }

  private void sync(AgentCredentials.Active active) {
    AgentPolicy.Key key = policy.state().key();
    boolean expired = active != null && active.expiresAt() > 0 && active.expiresAt() <= System.currentTimeMillis();
    if (active == null || expired) {
      if (key != null) step(new AgentPolicy.CredentialWithdrawn(expired ? "The device credential expired" : "The device was signed out"));
      return;
    }
    String account = remember(active.account());
    if (key == null) step(new AgentPolicy.CredentialArrived(active.version(), account));
    else if (!account.equals(key.account())) step(new AgentPolicy.AccountChanged(active.version(), account));
    else if (active.version() > key.version()) step(new AgentPolicy.CredentialReplaced(active.version()));
  }

  private String remember(AgentCredentials.Account account) {
    String digest = AgentDirectories.accountDigest(account.userId(), account.organizationId());
    accounts.put(digest, account);
    return digest;
  }

  private void push(AgentPolicy.PushCredential push) {
    long launchEpoch = base + push.epoch();
    AgentCredentials.Active active;
    try { active = currentKey(); }
    catch (Exception unreadable) {
      Log.w(TAG, "The device credential could not be read for the push", unreadable);
      later(() -> settled(() -> pushFailed(launchEpoch, push.version())));
      return;
    }
    if (active == null || active.version() != push.version()) {
      later(() -> settled(this::syncCredential));
      return;
    }
    AgentSocketClient.CredentialPush body = new AgentSocketClient.CredentialPush(active.version(), active.value(), active.expiresAt(),
      new AgentSocketClient.Account(active.account().userId(), active.account().organizationId()));
    offload(() -> {
      AgentSocketClient.PushResult result;
      try { result = CHANNEL.pushCredential(body); }
      catch (IOException failed) {
        Log.w(TAG, "Credential version " + push.version() + " could not be pushed to the agent", failed);
        later(() -> settled(() -> pushFailed(launchEpoch, push.version())));
        return;
      }
      if (result instanceof AgentSocketClient.PushAccepted) return;
      Log.w(TAG, "The agent did not take credential version " + push.version() + ": " + result);
      if (result instanceof AgentSocketClient.PushRefused refused && ("stale_version".equals(refused.reason()) || "not_cloud".equals(refused.reason()))) return;
      later(() -> settled(() -> pushFailed(launchEpoch, push.version())));
    });
  }

  private void pushFailed(long launchEpoch, long version) {
    AgentPolicy.State state = policy.state();
    if (!owns(launchEpoch) || state.phase() != Phase.RUNNING || state.delivered() != version) return;
    Log.w(TAG, "Restarting the agent so that its launch frame carries credential version " + version);
    step(new AgentPolicy.Stop());
    step(new AgentPolicy.Start());
  }

  private Path accountState() throws IOException {
    AgentPolicy.State state = policy.state();
    AgentCredentials.Account account = accounts.get(state.key() != null ? state.key().account() : state.launched());
    if (account == null) throw new IOException("The agent's account is not known to this service");
    return directories.state(account.userId(), account.organizationId());
  }

  private int retained() {
    try (Stream<Path> files = Files.walk(accountState())) {
      return (int) files.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)).count();
    } catch (IOException | RuntimeException unreadable) {
      Log.w(TAG, "The agent's records could not be counted", unreadable);
      return 0;
    }
  }

  private void archive(AgentPolicy.Archive archive) {
    try {
      int count = retained();
      RecoveryArchive.archive(accountState(), directories.recoveryArchive(), base + archive.epoch(), System.currentTimeMillis(), directories.sync());
      archived = count;
    } catch (IOException failed) {
      Log.e(TAG, "The agent's records could not be moved aside", failed);
      archived = -1;
    }
  }

  private UpdateHold holdStore() throws IOException {
    if (hold == null) throw new IOException(initFailure);
    return hold;
  }

  private boolean hold(AgentPolicy.UpdateTarget target) throws IOException {
    if (target.equals(policy.state().hold())) return true;
    UpdateHold store = holdStore();
    if (policy.state().child() instanceof AgentPolicy.Stale) {
      journal.reapStale(base + policy.state().epoch());
      step(new AgentPolicy.ReapStale());
    }
    if (!step(new AgentPolicy.HoldForUpdate(target)).accepted()) return false;
    try {
      store.save(target);
      return true;
    } catch (IOException | RuntimeException failed) {
      step(new AgentPolicy.ReleaseUpdate(target.code(), target.digest(), true));
      throw failed;
    }
  }

  private Path writeLaunch(String document) throws IOException {
    Path runtime = directories.runtime();
    Path target = runtime.resolve("launch.json");
    Path next = Files.createTempFile(runtime, ".launch-", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
    try {
      Files.write(next, document.getBytes(StandardCharsets.UTF_8), StandardOpenOption.WRITE, StandardOpenOption.SYNC);
      Files.move(next, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      directories.sync().directory(runtime);
    } finally {
      Files.deleteIfExists(next);
    }
    return target;
  }

  @SuppressWarnings("unchecked")
  private static String launchDocument(AgentConfig config, AgentCredentials.Account account, Optional<PayloadCheck.WorkflowWorker> worker,
      Map<String, String> variables) throws LaunchRefused {
    String document = config.launchDocument(account, worker.map(staged ->
      new AgentConfig.WorkflowWorker(staged.runtimeDir().toString(), staged.executable().toString(), staged.sha256())).orElse(null));
    if (variables.isEmpty()) return document;
    Map<String, Object> parsed = (Map<String, Object>) RouteGate.Json.parse(document);
    Map<String, Object> environment = parsed.get("environment") instanceof Map<?, ?> set ? new LinkedHashMap<>((Map<String, Object>) set) : new LinkedHashMap<>();
    for (Map.Entry<String, String> variable : variables.entrySet()) {
      String name = variable.getKey();
      if (name == null || !VARIABLE.matcher(name).matches() || RESERVED.matcher(name).matches() || variable.getValue() == null || environment.containsKey(name))
        throw new LaunchRefused("The launch hook may not set " + name);
      environment.put(name, variable.getValue());
    }
    parsed.put("environment", environment);
    return AgentConfig.json(parsed);
  }

  private long versionCode() throws PackageManager.NameNotFoundException {
    return getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
  }

  private void cancelTimers() {
    for (ScheduledFuture<?> timer : timers) timer.cancel(false);
    timers.clear();
  }

  private static void changed() {
    for (Runnable observer : observers) notices.execute(observer);
  }

  private static ScheduledThreadPoolExecutor effectExecutor() {
    ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1, task -> daemon(task, "ElizaAgentService"));
    executor.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    executor.setContinueExistingPeriodicTasksAfterShutdownPolicy(false);
    executor.setRemoveOnCancelPolicy(true);
    return executor;
  }

  private static ExecutorService daemonSingle(String name) {
    return Executors.newSingleThreadExecutor(task -> daemon(task, name));
  }

  private static Thread daemon(Runnable task, String name) {
    Thread thread = new Thread(task, name);
    thread.setDaemon(true);
    return thread;
  }
}
