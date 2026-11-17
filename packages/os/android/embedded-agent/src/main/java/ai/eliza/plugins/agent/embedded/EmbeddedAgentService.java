package ai.eliza.plugins.agent.embedded;

import ai.eliza.plugins.agent.runtime.AndroidRuntimeDirectories;
import ai.eliza.plugins.agent.runtime.EmbeddedRuntimeLaunch;
import ai.eliza.plugins.agent.runtime.EmbeddedRuntimeGroup;
import ai.eliza.plugins.agent.runtime.EmbeddedRuntimeService;
import ai.eliza.plugins.agent.runtime.LocalRuntimeSocket;
import ai.eliza.plugins.agent.runtime.NativeRuntimeSession;
import ai.eliza.plugins.agent.runtime.RuntimeAssets;
import ai.eliza.plugins.agent.runtime.RuntimeBundleStore;
import ai.eliza.plugins.agent.runtime.RuntimeStartFailure;
import ai.eliza.plugins.agent.runtime.RuntimeStartFailure.Cause;
import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import java.io.File;
import java.io.IOException;
import android.net.LocalSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/** The embedded agent with cloud inference only, configured by the consumer's data files
 * ({@link EmbeddedAgentConfig}). It runs the agent alone, with no gateway: the native bridge
 * is the agent's only client and admits the configured routes itself. Android restarts the
 * service after its process is killed; the supervisor restarts a crashed agent within its
 * budget, and the status names which part failed to start. A host binds the Eliza Cloud
 * credential by overriding {@link #cloudAccount()} and registers {@link EmbeddedAgentPlugin}
 * with its Capacitor bridge. */
public class EmbeddedAgentService extends EmbeddedRuntimeService {
  private static final String CHANNEL = "eliza-embedded-agent";
  private static final int NOTIFICATION = 7301;
  private static final int MAX_BODY = 16 * 1024 * 1024;
  private static final String[] PAYLOAD_ASSETS = {RuntimeBundleStore.INVENTORY, "agent/" + RuntimeBundleStore.BUNDLE};
  private static volatile EmbeddedAgentConfig loaded;
  private static volatile boolean payloadFound;

  public EmbeddedAgentService() { super(new Policy(2000, 3000, 2, 512 * 1024, 4096, 180000, 1000, MAX_BODY)); }

  /** The signed-in Eliza Cloud credential, or null when there is none. Never shown to the page. */
  public record CloudAccount(String credential, String userId, String organizationId) {
    @Override public String toString() { return "EmbeddedAgentService.CloudAccount"; }
  }
  protected CloudAccount cloudAccount() throws Exception { return null; }

  public static EmbeddedAgentConfig config(Context context) throws IOException {
    EmbeddedAgentConfig config = loaded;
    if (config != null) return config;
    RuntimeBundleStore.Source assets = name -> context.getAssets().open(name);
    config = EmbeddedAgentConfig.parse(asset(assets, EmbeddedAgentConfig.HOST_ASSET), asset(assets, EmbeddedAgentConfig.CHARACTER_ASSET), asset(assets, EmbeddedAgentConfig.POLICY_ASSET));
    loaded = config;
    return config;
  }
  private static String asset(RuntimeBundleStore.Source assets, String name) throws IOException {
    return new String(RuntimeAssets.read(assets, name, EmbeddedAgentConfig.MAX_ASSET_BYTES), StandardCharsets.UTF_8);
  }

  static Class<? extends EmbeddedAgentService> serviceClass(Context context) throws IOException {
    try { return Class.forName(config(context).service).asSubclass(EmbeddedAgentService.class); }
    catch (ClassNotFoundException | ClassCastException missing) { throw new IOException("The embedded agent service class is not in this build", missing); }
  }

  static boolean payloadAvailable(Context context) {
    if (payloadFound) return true;
    boolean found = RuntimeAssets.available(name -> context.getAssets().open(name),
      new File(context.getApplicationInfo().nativeLibraryDir).toPath(), new String[]{"libeliza_node.so"}, PAYLOAD_ASSETS);
    payloadFound = found;
    return found;
  }

  static JSONObject status(Context context, Class<? extends EmbeddedAgentService> type) throws JSONException {
    return statusFor(type, payloadAvailable(context), "The agent could not start");
  }
  static JSONObject request(Class<? extends EmbeddedAgentService> type, String method, String path, String body) throws Exception {
    return requestFor(type, (endpoint) -> LocalRuntimeSocket.exchange(endpoint.socket, endpoint.token, method, path, body, 120000), "The agent is not ready", "The agent restarted during the request");
  }
  static JSONObject stream(Class<? extends EmbeddedAgentService> type, LocalSocket socket, String method, String path, String body,
      LocalRuntimeSocket.Events events) throws Exception {
    return requestFor(type, (endpoint) -> LocalRuntimeSocket.stream(socket, endpoint.socket, endpoint.token, method, path, body, 120000, MAX_BODY, events),
      "The agent is not ready", "The agent restarted during the request");
  }
  static AutoCloseable observe(Class<? extends EmbeddedAgentService> type, Runnable observer) { return observeFor(type, observer); }
  static void prepareRestart(Class<? extends EmbeddedAgentService> type) { prepareRestartFor(type); }

  @Override protected File runtimeRootDirectory() { return new File(getNoBackupFilesDir(), "embedded-agent"); }
  @Override protected int runtimeNotificationId() { return NOTIFICATION; }
  @Override protected int runtimeForegroundType() {
    return Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST;
  }
  private String[] words() {
    String label = getApplicationInfo().loadLabel(getPackageManager()).toString();
    try { EmbeddedAgentConfig.Notification words = config(this).notification; return new String[]{words.channel, words.title, words.text}; }
    catch (IOException unreadable) { return new String[]{label, label, ""}; }
  }
  @Override protected NotificationChannel runtimeNotificationChannel() {
    return new NotificationChannel(CHANNEL, words()[0], NotificationManager.IMPORTANCE_LOW);
  }
  @Override protected Notification runtimeNotification() {
    String[] words = words();
    Notification.Builder builder = new Notification.Builder(this, CHANNEL).setSmallIcon(getApplicationInfo().icon)
      .setContentTitle(words[1]).setContentText(words[2]).setOngoing(true);
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (open != null) builder.setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE));
    return builder.build();
  }

  @Override public synchronized int onStartCommand(Intent intent, int flags, int startId) {
    boolean stop = intent != null && "stop".equals(intent.getAction());
    try { super.onStartCommand(intent, flags, startId); }
    catch (IllegalStateException refused) {
      if (Build.VERSION.SDK_INT < 31 || !(refused instanceof ForegroundServiceStartNotAllowedException)) throw refused;
      stopSelf();
      return START_NOT_STICKY;
    }
    return stop ? START_NOT_STICKY : START_STICKY;
  }

  @Override protected void launch(NativeRuntimeSession.Scope scope) throws Exception {
    scope.check();
    EmbeddedAgentConfig config;
    try { config = config(this); }
    catch (IOException invalid) { throw new RuntimeStartFailure(Cause.CONFIG, "The agent's configuration is missing or invalid", invalid); }
    CloudAccount account;
    try { account = cloudAccount(); }
    catch (Exception unavailable) { throw new RuntimeStartFailure(Cause.CREDENTIAL, "The Cloud device credential could not be read", unavailable); }
    if (account == null) throw new RuntimeStartFailure(Cause.CREDENTIAL, "No account is signed in", null);
    scope.check();
    Path bundle = prepareBundle();
    File state = new File(root, "state");
    EmbeddedRuntimeLaunch launch;
    try { launch = new EmbeddedRuntimeLaunch(bundle, new File(getApplicationInfo().nativeLibraryDir).toPath(), state.toPath()); }
    catch (IOException missing) { throw new RuntimeStartFailure(Cause.PAYLOAD, "The agent runtime is not installed", missing); }
    File configFile = new File(state, "config.json");
    writePrivate(configFile, config.agentConfig(account.userId(), account.organizationId()).toString().getBytes(StandardCharsets.UTF_8));
    group.launchAgent(scope, root.toPath(), endpoint -> {
      JSONObject frame = new JSONObject().put("version", 1).put("token", endpoint.token).put("epoch", endpoint.epoch)
        .put("credential", new JSONObject().put("version", 1).put("value", account.credential()));
      return new EmbeddedRuntimeGroup.Launch(launch.agent(configFile.toPath(), endpoint.socket),
        (frame.toString() + "\n").getBytes(StandardCharsets.UTF_8), List.of(endpoint.token, account.credential()));
    });
  }

  private Path prepareBundle() throws RuntimeStartFailure {
    if (!payloadAvailable(this)) throw new RuntimeStartFailure(Cause.PAYLOAD, "This build does not include the agent runtime", null);
    try {
      AndroidRuntimeDirectories.ensurePrivateRuntimeParent(root.getParentFile());
      if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot create the private runtime directory");
      long version = getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
      return RuntimeBundleStore.prepare(root.toPath().resolve("releases"), version, name -> getAssets().open(name),
        new File(getApplicationInfo().nativeLibraryDir).toPath(), AndroidRuntimeDirectories::syncRuntimeDirectory);
    } catch (IOException | android.content.pm.PackageManager.NameNotFoundException failure) {
      throw new RuntimeStartFailure(Cause.PAYLOAD, "The agent runtime could not be verified", failure);
    }
  }
}
