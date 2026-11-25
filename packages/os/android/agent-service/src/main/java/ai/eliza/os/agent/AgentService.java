// spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"; spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"; spec/os/agentService/lifecycle.md, "Story: Restart a crashed or unhealthy agent until it stays up"; spec/os/agentService/lifecycle.md, "Story: Recover my agent's records after a storage failure"; spec/os/agentService/lifecycle.md, "Story: Hold the agent for an app update"; spec/os/agentService/lifecycle.md, "Story: Hand a new device key of the same account to the running agent"; spec/os/agentService/health.md, "Story: Tell a busy agent from an absent one"; spec/os/agentService/lifecycle.md, "Story: See a failed agent even when I silence its status"; spec/os/agentService/lifecycle.md, "A failed agent's notice is on the alerts channel with the failure words, and a starting, running or stopping agent's on the status channel"; spec/os/agentService/config.md, "Story: Start my agent with my character, policy and model"; spec/os/agentService/config.md, "Only a cloud launch is framed with the device key, and an own-key launch with the owner's provider key or none"; spec/os/agentService/channel.md, "Only the device headers and client id the runtime client carries cross the channel"; spec/os/agentService/config.md, "Only a cloud launch is handed the mail broker, by its address and a bearer for that launch, never a credential"
package ai.eliza.os.agent;

import ai.eliza.os.agent.AgentPolicy.Effect;
import ai.eliza.os.agent.AgentPolicy.Notice;
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
import org.json.JSONException;
import org.json.JSONObject;

public class AgentService extends Service {
  public static final String ACTION_START = "ai.eliza.os.agent.action.START";
  public static final String ACTION_RESTART = "ai.eliza.os.agent.action.RESTART";
  public static final String ACTION_STOP = "ai.eliza.os.agent.action.STOP";
  public static final long REQUEST_BODY_LIMIT = 16L * 1024 * 1024;
  private static final String TAG = "ElizaAgent";
  private static final String NOTIFICATION_CHANNEL = "eliza-agent";
  private static final String ALERTS_CHANNEL = "eliza-agent-alerts";
  private static final int NOTIFICATION_ID = 7301;
  private static final long CALL_TIMEOUT_MS = 30_000L;
  private static final String HEALTH = "/api/health";
  private static final Pattern VARIABLE = Pattern.compile("[A-Z][A-Z0-9_]*");
  private static final Pattern RESERVED = Pattern.compile("(ELIZA_AGENT_|ELIZA_CLOUD_|ELIZA_OWN_|LD_|NODE_).*|PATH|HOME|TMPDIR");
  private static final Object LOCK = new Object();
  private static final Object EPOCH_LOCK = new Object();
  private static final AgentChannel CHANNEL = new AgentChannel(new ChannelPolicy(), AgentSocketClient.android());
  private static final Set<Runnable> observers = new CopyOnWriteArraySet<>();
  private static final Set<Runnable> readyObservers = new CopyOnWriteArraySet<>();
  private static final ExecutorService notices = daemonSingle("ElizaAgentNotices");
  private static volatile AgentService live;
  private static volatile AgentConfig loaded;
  private static volatile AgentCredentials registered = AgentCredentials.NONE;
  private static volatile GoogleBroker googleBroker;

  public record Review(String token, int retainedCount) {}

  public static final class LaunchRefused extends Exception {
    public LaunchRefused(String reason) { super(reason); }
  }

  private final ScheduledThreadPoolExecutor effects = effectExecutor();
  private final ExecutorService work = Executors.newCachedThreadPool(task -> daemon(task, "ElizaAgentWork"));
  private final AgentSocketClient client = AgentSocketClient.android();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Map<String, AgentCredentials.Account> accounts = new HashMap<>();
  private final RecoveryArchive recoveryArchive = new RecoveryArchive();
  private final List<ScheduledFuture<?>> timers = new ArrayList<>();
  private volatile AgentPolicy policy = new AgentPolicy(null, null);
  private int appliedStartId;
  private boolean foreground;
  private Notice shown = Notice.NONE;
  private String initFailure;
  private AgentDirectories directories;
  private ChildJournal journal;
  private UpdateHoldFile hold;
  private AgentSupervisor.Child child;
  private AgentPolicy.Check checkAfterReap;
  private String token;
  private Path socket;
  private HealthPolicy.HealthWatch watch = HealthPolicy.HealthWatch.FRESH;
  private CompletableFuture<Review> review;
  private int archived = -1;
  private AgentPolicy.UpdateTarget pendingHold;

  public static void useCredentials(AgentCredentials source) { registered = Objects.requireNonNull(source); }

  public static void useGoogleBroker(GoogleBroker broker) { googleBroker = Objects.requireNonNull(broker); }

  protected AgentCredentials credentials() { return registered; }

  protected void configureLaunch(Map<String, String> variables) throws LaunchRefused { }

  /**
   * The Google consent the owner saved for the agent, read once per launch after {@link #configureLaunch}; null launches with the
   * host file's {@code google}. A changed choice reaches the agent only through a new launch, so the subclass restarts it.
   */
  protected AgentConfig.GoogleConsent googleConsent() throws LaunchRefused { return null; }

  protected NotificationChannel runtimeNotificationChannel() {
    return new NotificationChannel(NOTIFICATION_CHANNEL, words().status().channel(), NotificationManager.IMPORTANCE_LOW);
  }

  protected NotificationChannel runtimeAlertsChannel() {
    return new NotificationChannel(ALERTS_CHANNEL, words().failure().channel(), NotificationManager.IMPORTANCE_LOW);
  }

  /** The notice of a starting, running or stopping agent, on the status channel with the host file's status words. */
  protected Notification runtimeNotification() {
    return notice(NOTIFICATION_CHANNEL, words().status());
  }

  /** The notice of a failed agent, on the alerts channel with the host file's failure words. */
  protected Notification runtimeFailureNotification() {
    return notice(ALERTS_CHANNEL, words().failure());
  }

  private Notification notice(String channel, AgentConfig.Words words) {
    Notification.Builder builder = new Notification.Builder(this, channel).setSmallIcon(getApplicationInfo().icon)
      .setContentTitle(words.title()).setContentText(words.text()).setOngoing(true);
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (open != null) builder.setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE));
    return builder.build();
  }

  private Notification runtimeNotification(Notice notice) {
    return notice == Notice.ALERTS ? runtimeFailureNotification() : runtimeNotification();
  }

  protected final Notification.Action stopAction(CharSequence label) {
    PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, getClass()).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Action.Builder(null, label, stop).build();
  }

  public static AgentChannel channel() { return CHANNEL; }

  public static CompletableFuture<AgentChannel.Response> request(String method, String path, byte[] body) {
    return CHANNEL.request(CallerKind.NATIVE, method, path, body);
  }

  /** As {@link #request(String, String, byte[])}, carrying the device headers and client id the channel admits. */
  public static CompletableFuture<AgentChannel.Response> request(String method, String path, byte[] body, Map<String, ?> headers) {
    return CHANNEL.request(CallerKind.NATIVE, method, path, body, headers);
  }

  public static AgentChannel.Call requestStream(String method, String path, byte[] body, AgentChannel.Listener listener) {
    return CHANNEL.requestStream(CallerKind.NATIVE, method, path, body, listener);
  }

  /** As {@link #requestStream(String, String, byte[], AgentChannel.Listener)}, carrying the device headers and client id the channel admits. */
  public static AgentChannel.Call requestStream(String method, String path, byte[] body, Map<String, ?> headers, AgentChannel.Listener listener) {
    return CHANNEL.requestStream(CallerKind.NATIVE, method, path, body, headers, listener);
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
    AgentPolicy.Status status = service == null ? new AgentPolicy(null, null).status(REQUEST_BODY_LIMIT) : service.policy.status(REQUEST_BODY_LIMIT);
    try {
      JSONObject out = new JSONObject().put("available", status.available()).put("state", status.state())
        .put("epoch", status.epoch()).put("requestBodyLimit", status.requestBodyLimit());
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
    if (service != null) service.later(() -> service.settled(() -> service.step(new AgentPolicy.Stop())));
  }

  public static void credentialChanged(Context context) {
    AgentService service = live;
    if (service != null) {
      service.later(() -> service.settled(service::syncCredential));
      return;
    }
    if (signedIn()) start(context);
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

  static void holdForUpdate(Context context, AgentPolicy.UpdateTarget target) throws IOException {
    synchronized (LOCK) {
      AgentService service = live;
      if (service == null) {
        UpdateHoldFile store = UpdateHold.of(context);
        AgentPolicy policy = new AgentPolicy(null, store.held());
        if (policy.state().hold() == null) {
          AgentDirectories dirs = new AgentDirectories(context.getFilesDir().toPath(), AndroidRuntimeDirectories::syncRuntimeDirectory);
          store.acquire(policy, new ChildJournal(dirs.journal(), new AndroidChildProcesses(), dirs.sync()), target);
        }
        return;
      }
      service.call(() -> {
        service.settled(() -> {
          try { service.hold(target); }
          catch (IOException failed) { throw new IllegalStateException(failed); }
        });
        return null;
      });
    }
  }

  static boolean releaseUpdate(Context context, long installedCode, String installedDigest, boolean attemptEnded) throws IOException {
    AgentPolicy.ReleaseUpdate release = new AgentPolicy.ReleaseUpdate(installedCode, installedDigest, attemptEnded);
    synchronized (LOCK) {
      AgentService service = live;
      if (service == null) {
        UpdateHoldFile store = UpdateHold.of(context);
        return store.releaseSaved(release);
      }
      return service.call(() -> service.publish(service.hold.release(service.policy, release)).accepted());
    }
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
    getSystemService(NotificationManager.class).createNotificationChannels(List.of(runtimeNotificationChannel(), runtimeAlertsChannel()));
    if (!showForeground()) {
      stopSelf();
      return;
    }
    synchronized (LOCK) {
      AgentCredentials.Active active = null;
      try { active = credentials().current(); }
      catch (Exception unreadable) { Log.w(TAG, "The device credential could not be read", unreadable); }
      synchronized (EPOCH_LOCK) {
        AgentPolicy.UpdateTarget held = null;
        ChildJournal.LaunchState launch = new ChildJournal.LaunchState(0, 0);
        try {
          directories = new AgentDirectories(getFilesDir().toPath(), AndroidRuntimeDirectories::syncRuntimeDirectory);
          journal = new ChildJournal(directories.journal(), new AndroidChildProcesses(), directories.sync());
          hold = UpdateHold.of(this);
          launch = journal.restoreLaunch();
          held = hold.held();
        } catch (IOException | RuntimeException unreadable) {
          initFailure = "The agent's private storage could not be read: " + unreadable.getMessage();
          Log.e(TAG, initFailure, unreadable);
        }
        policy = new AgentPolicy(active == null ? null : remember(active.account()), held, launch.epoch(), launch.staleEpoch(), this::reserveLaunch);
        live = this;
      }
    }
    later(() -> settled(this::syncCredential));
    changed();
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_STOP.equals(intent.getAction())) {
      post(startId, new AgentPolicy.Stop());
      return START_NOT_STICKY;
    }
    if (!foreground && !showForeground()) {
      stopSelfResult(startId);
      return START_NOT_STICKY;
    }
    if (intent != null && ACTION_RESTART.equals(intent.getAction())) post(startId, new AgentPolicy.Stop(), new AgentPolicy.Start());
    else post(startId, new AgentPolicy.Start());
    return START_STICKY;
  }

  @Override public void onDestroy() {
    synchronized (LOCK) {
      synchronized (EPOCH_LOCK) { if (live == this) live = null; }
    }
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
      AgentConfig.Words fallback = new AgentConfig.Words(label, label, "");
      return new AgentConfig.Notification(fallback, fallback);
    }
  }

  private boolean showForeground() {
    try {
      int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST;
      Notice notice = policy.state().notice() == Notice.ALERTS ? Notice.ALERTS : Notice.STATUS;
      startForeground(NOTIFICATION_ID, runtimeNotification(notice), type);
      foreground = true;
      shown = notice;
      return true;
    } catch (IllegalStateException refused) {
      if (Build.VERSION.SDK_INT < 31 || !(refused instanceof ForegroundServiceStartNotAllowedException)) throw refused;
      Log.w(TAG, "Android refused to start the agent in the foreground", refused);
      return false;
    }
  }

  private void post(int startId, AgentPolicy.Event... events) {
    later(() -> settled(() -> {
      appliedStartId = startId;
      for (AgentPolicy.Event event : events) step(event);
    }));
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

  private void settled(Runnable steps) {
    steps.run();
    if (pendingHold != null && !policy.state().child()) {
      try { hold(pendingHold); }
      catch (IOException failed) { Log.e(TAG, "The update hold could not be saved", failed); }
    }
    int startId = appliedStartId;
    main.post(() -> {
      AgentPolicy.State state = policy.state();
      boolean stopped = state.phase() == Phase.STOPPED;
      if (stopped && foreground) {
        stopForeground(STOP_FOREGROUND_REMOVE);
        foreground = false;
      } else if (!stopped && !foreground) {
        showForeground();
      } else if (!stopped && state.notice() != shown) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, runtimeNotification(state.notice()));
        shown = state.notice();
      }
      if (stopped && !state.child()) stopSelfResult(startId);
    });
  }

  private AgentPolicy.Step step(AgentPolicy.Event event) {
    if (pendingHold != null && event instanceof AgentPolicy.Start) return new AgentPolicy.Step(false, policy.state(), List.of());
    return publish(policy.step(event));
  }

  private void reserveLaunch(long epoch) throws IOException {
    synchronized (EPOCH_LOCK) {
      if (live != this) throw new IOException("The agent service has ended");
      if (initFailure != null) throw new IOException(initFailure);
      journal.reserveLaunch(epoch);
    }
  }

  private AgentPolicy.Step publish(AgentPolicy.Step step) {
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
      if (target != null && target.epoch == kill.epoch()) work.execute(target::stop);
    } else if (effect instanceof AgentPolicy.PushCredential push) push(push);
    else if (effect instanceof AgentPolicy.RecoveryReview recovery) {
      if (review != null) {
        String token = recovery.token().epoch() + "." + recovery.token().nonce();
        review.complete(new Review(token, retained(policy.state().account())));
      }
    } else archive((AgentPolicy.Archive) effect);
  }

  private void check(AgentPolicy.Check check) {
    AgentPolicy.State state = policy.state();
    long epoch = check.epoch();
    if (!checking(state, epoch)) return;
    if (state.staleEpoch() != 0 && owns(state.staleEpoch())) {
      checkAfterReap = check;
      return;
    }
    if (initFailure != null) {
      step(new AgentPolicy.FailUnclassified(initFailure));
      return;
    }
    try { journal.reapStale(epoch); }
    catch (IOException failed) {
      step(new AgentPolicy.FailUnclassified("The previous agent could not be ended: " + failed.getMessage()));
      return;
    }
    if (state.staleEpoch() != 0) step(new AgentPolicy.StaleChildReaped(state.staleEpoch()));
    if (!step(new AgentPolicy.ReapStale()).accepted()) return;
    AgentConfig config;
    try { config = config(this); }
    catch (AgentConfig.Refused | IOException refused) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.CONFIG, refused.getMessage()));
      return;
    }
    CHANNEL.policy().loadRoutes(CallerKind.NATIVE, config.routes(CallerKind.NATIVE));
    if (!CHANNEL.policy().loadRoutes(CallerKind.RENDERER, config.routes(CallerKind.RENDERER))) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.CONFIG, "The agent's renderer route list could not be loaded"));
      return;
    }
    PayloadCheck.Check payload;
    try {
      payload = PayloadCheck.prepare(name -> getAssets().open(name), versionCode(), List.of(Build.SUPPORTED_ABIS),
        Paths.get(getApplicationInfo().nativeLibraryDir), directories.runtime(), directories.sync());
    } catch (IOException | PackageManager.NameNotFoundException failed) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.PAYLOAD, "The agent runtime could not be verified: " + failed.getMessage()));
      return;
    }
    if (payload instanceof PayloadCheck.Failed failed) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.PAYLOAD, String.join("; ", failed.errors())));
      return;
    }
    launchChecked(epoch, config, ((PayloadCheck.Ready) payload).payload());
  }

  private boolean checking(AgentPolicy.State state, long epoch) {
    return live == this && state.phase() == Phase.CHECKING && state.epoch() == epoch;
  }

  private void launchChecked(long epoch, AgentConfig config, PayloadCheck.PreparedPayload prepared) {
    AgentPolicy.State before = policy.state();
    if (!checking(before, epoch)) return;
    AgentCredentials credentialSource;
    AgentCredentials.Active active;
    try {
      credentialSource = credentials();
      active = credentialSource.current();
    } catch (Exception unreadable) {
      step(new AgentPolicy.FailUnclassified("The device credential could not be read: " + unreadable.getMessage()));
      return;
    }
    sync(active);
    AgentPolicy.State current = policy.state();
    if (!checking(current, epoch)) return;
    if (!before.credentialHeld() && current.credentialHeld() && !Objects.equals(before.account(), current.account())) {
      later(() -> settled(() -> launchChecked(epoch, config, prepared)));
      return;
    }
    String storageKey;
    LaunchFrame.Credential framed;
    try {
      storageKey = active == null ? null : credentialSource.storageKey(active.account());
      framed = config.ownKey()
        ? credentialSource.providerKey()
        : config.needsAccount() ? LaunchFrame.Credential.of(active) : null;
    } catch (Exception unreadable) {
      step(new AgentPolicy.FailUnclassified("The device credential could not be read: " + unreadable.getMessage()));
      return;
    }
    Map<String, String> variables = new LinkedHashMap<>();
    String document = null;
    String refusal = null;
    try {
      configureLaunch(variables);
      document = launchDocument(config, active == null ? null : active.account(), prepared.workflowWorker(), variables, googleConsent());
    } catch (LaunchRefused | IllegalArgumentException refused) {
      refusal = refused.getMessage();
    }
    if (!step(new AgentPolicy.LaunchHook(refusal != null, refusal)).accepted() || policy.state().phase() != Phase.CHECKING) return;
    String launchToken = LaunchFrame.newToken();
    LaunchFrame readyFrame;
    try {
      readyFrame = config.initialFrame(launchToken, epoch, framed, storageKey);
    } catch (AgentConfig.Refused refused) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.CONFIG, refused.getMessage()));
      return;
    } catch (RuntimeException failed) {
      step(new AgentPolicy.SpawnFailed("The agent could not be started: " + failed.getMessage()));
      return;
    }
    Path stateDir;
    try {
      recoveryArchive.requireSettled(active.account());
      stateDir = directories.state(active.account().userId(), active.account().organizationId());
    } catch (IOException failed) {
      step(new AgentPolicy.Refuse(AgentPolicy.Cause.STORAGE, "The agent's state directory is not usable: " + failed.getMessage()));
      return;
    }
    AgentSupervisor.Child spawned;
    try {
      Path launch = writeLaunch(document);
      Path agentSocket = directories.prepareSocket();
      byte[] frame = readyFrame.encode();
      Map<String, String> broker = GoogleBroker.launchEnvironment(config.needsAccount(), active.account(), googleBroker, unavailable ->
        Log.w(TAG, "The mail broker could not open, so the agent starts without it", unavailable));
      AgentSupervisor.Command command = new AgentSupervisor.Command(prepared.node(), prepared.bundleDir(), launch, stateDir, agentSocket,
        directories.runtime().resolve("agent.log"), broker);
      synchronized (EPOCH_LOCK) {
        if (live != this) return;
        spawned = AgentSupervisor.spawn(epoch, command, frame, (spawnedEpoch, pid) -> journal.record(Math.toIntExact(pid), spawnedEpoch),
          readyEpoch -> HealthPolicy.classify(probe(agentSocket, launchToken, () -> true), readyEpoch) == HealthPolicy.Probe.OK,
          new AgentSupervisor.Listener() {
            @Override public void ready(long readyEpoch) { later(() -> settled(() -> ready(readyEpoch))); }
            @Override public void readinessTimedOut(long timedOut) { later(() -> settled(() -> { if (owns(timedOut)) step(new AgentPolicy.ReadyTimeout()); })); }
            @Override public void exited(long exitedEpoch, int code) { later(() -> settled(() -> exited(exitedEpoch, code))); }
          });
      }
      socket = agentSocket;
    } catch (IOException | RuntimeException failed) {
      step(new AgentPolicy.SpawnFailed("The agent could not be started: " + failed.getMessage()));
      return;
    }
    child = spawned;
    token = launchToken;
    if (!step(new AgentPolicy.Spawned()).accepted()) spawned.kill();
  }

  private boolean owns(long launchEpoch) { return child != null && child.epoch == launchEpoch; }

  private void ready(long launchEpoch) {
    if (!owns(launchEpoch) || policy.state().phase() != Phase.SPAWNED) return;
    CHANNEL.open(launchEpoch, token, socket);
    if (!step(new AgentPolicy.ObserveReady(launchEpoch)).accepted()) {
      CHANNEL.retire(launchEpoch);
      return;
    }
    watch = HealthPolicy.HealthWatch.FRESH;
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
    boolean stale = policy.state().staleEpoch() == launchEpoch;
    try {
      if (stale) clearStaleChild(launchEpoch);
      else journal.clear(launchEpoch);
    }
    catch (IOException failed) { Log.e(TAG, "The agent child journal could not be cleared", failed); }
    Log.i(TAG, "The agent of epoch " + launchEpoch + " exited with code " + code);
    if (!stale) step(new AgentPolicy.ObserveExit(code));
    if (checkAfterReap != null) {
      AgentPolicy.Check next = checkAfterReap;
      checkAfterReap = null;
      later(() -> settled(() -> check(next)));
    }
  }

  private void clearStaleChild(long epoch) throws IOException {
    if (journal.observe() instanceof ChildJournal.Journaled observed && observed.alive())
      throw new IOException("The journaled agent child is still running");
    journal.clear(epoch);
    step(new AgentPolicy.StaleChildReaped(epoch));
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
        HealthPolicy.Verdict verdict = HealthPolicy.verdict(watch, seen, launchEpoch);
        watch = HealthPolicy.afterObservation(watch, seen, launchEpoch);
        if (verdict == HealthPolicy.Verdict.RESTART) step(new AgentPolicy.RestartUnhealthy());
      }));
    });
  }

  private HealthPolicy.ProbeReply probe(Path agentSocket, String launchToken, BooleanSupplier alive) {
    AtomicBoolean connected = new AtomicBoolean();
    AtomicReference<AgentSocketClient.Result> answer = new AtomicReference<>();
    try {
      client.exchange(agentSocket, launchToken, "health-" + UUID.randomUUID(), new AgentSocketClient.HttpCall("GET", HEALTH, null, false, Map.of()),
        link -> connected.set(true), frame -> {
          if (frame instanceof AgentSocketClient.Result result) answer.set(result);
          return false;
        });
    } catch (IOException | RuntimeException unanswered) {
      Log.d(TAG, "The agent did not answer its health probe: " + unanswered.getMessage());
    }
    AgentSocketClient.Result result = answer.get();
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

  private static boolean accepts(Path agentSocket) {
    if (agentSocket == null) return false;
    try (LocalSocket probe = new LocalSocket()) {
      probe.connect(new LocalSocketAddress(agentSocket.toString(), LocalSocketAddress.Namespace.FILESYSTEM));
      return true;
    } catch (IOException refused) {
      return false;
    }
  }

  private void syncCredential() {
    try { sync(credentials().current()); }
    catch (Exception unreadable) { Log.w(TAG, "The device credential could not be read", unreadable); }
  }

  private void sync(AgentCredentials.Active active) {
    AgentPolicy.State state = policy.state();
    boolean expired = active != null && active.expiresAt() > 0 && active.expiresAt() <= System.currentTimeMillis();
    if (active == null || expired) {
      if (state.credentialHeld()) step(expired ? new AgentPolicy.CredentialExpired() : new AgentPolicy.SignedOut());
      return;
    }
    String account = remember(active.account());
    if (!account.equals(state.account())) {
      if (state.credentialHeld()) step(new AgentPolicy.SignedOut());
      step(new AgentPolicy.AccountChanged(account));
    }
    step(new AgentPolicy.CredentialArrived(active.version()));
  }

  private String remember(AgentCredentials.Account account) {
    String digest = AgentDirectories.accountDigest(account.userId(), account.organizationId());
    accounts.put(digest, account);
    return digest;
  }

  private void push(AgentPolicy.PushCredential push) {
    AgentConfig launched = loaded;
    if (launched == null || !launched.needsAccount()) return;
    AgentCredentials.Active active;
    try { active = credentials().current(); }
    catch (Exception unreadable) {
      Log.w(TAG, "The device credential could not be read for the push", unreadable);
      return;
    }
    if (active == null || active.version() != push.version()) {
      Log.w(TAG, "The device credential changed before version " + push.version() + " could be pushed");
      return;
    }
    AgentSocketClient.CredentialPush body = new AgentSocketClient.CredentialPush(active.version(), active.value(),
      active.expiresAt(), new AgentSocketClient.Account(active.account().userId(), active.account().organizationId()));
    work.execute(() -> {
      try {
        AgentSocketClient.PushResult result = CHANNEL.pushCredential(body);
        if (!(result instanceof AgentSocketClient.PushAccepted)) Log.w(TAG, "The agent did not take credential version " + push.version() + ": " + result);
      } catch (IOException failed) {
        Log.w(TAG, "Credential version " + push.version() + " could not be pushed to the agent", failed);
      }
    });
  }

  private AgentCredentials.Account recoveryAccount(String accountKey) throws IOException {
    AgentCredentials.Account account = accounts.get(accountKey);
    if (account == null) throw new IOException("The agent's account is not known to this service");
    return account;
  }

  private int retained(String accountKey) {
    try {
      return recoveryArchive.retained(recoveryAccount(accountKey), directories);
    } catch (IOException | RuntimeException unreadable) {
      Log.w(TAG, "The agent's records could not be counted", unreadable);
      return 0;
    }
  }

  private void archive(AgentPolicy.Archive archive) {
    int count;
    try {
      count = recoveryArchive.archive(recoveryAccount(archive.account()), directories, retained(archive.account()),
        archive.token().epoch(), System.currentTimeMillis());
    } catch (IOException | RuntimeException failed) {
      Log.e(TAG, "The agent's records could not be moved aside", failed);
      step(new AgentPolicy.ArchiveFinished(archive.token(), false));
      return;
    }
    if (step(new AgentPolicy.ArchiveFinished(archive.token(), true)).accepted()) archived = count;
  }

  private void hold(AgentPolicy.UpdateTarget target) throws IOException {
    if (hold == null) throw new IOException("The update hold storage could not be opened");
    AgentPolicy.State state = policy.state();
    if (state.staleEpoch() != 0 && !owns(state.staleEpoch())) clearStaleChild(state.staleEpoch());
    try {
      if (publish(hold.acquire(policy, journal, target)).accepted()) {
        pendingHold = null;
        return;
      }
    } catch (IOException failed) {
      if (target.equals(policy.state().hold())) pendingHold = null;
      throw failed;
    }
    if (policy.state().child() && target.valid() && !target.equals(policy.state().hold())) {
      pendingHold = target;
      step(new AgentPolicy.Stop());
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
      Map<String, String> variables, AgentConfig.GoogleConsent consent) throws LaunchRefused {
    String document = config.launchDocument(account, worker.map(staged ->
      new AgentConfig.WorkflowWorker(staged.runtimeDir().toString(), staged.executable().toString(), staged.sha256())).orElse(null), consent);
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
