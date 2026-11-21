// spec/os/android/notificationProjection.md, "Story: Show the agent's notices once"; spec/os/android/notificationProjection.md, "A page continues the journal's own cursor, and only a complete page closes its whole fence"; spec/os/android/notificationProjection.md, "A pending notice is dispatched once, and its settlement never posts twice"
package ai.eliza.plugins.notifications;

import ai.eliza.os.agent.AgentChannel;
import ai.eliza.os.agent.AgentService;
import ai.eliza.os.agent.ChannelPolicy.Outcome;
import ai.eliza.os.agent.ChannelPolicy.Topic;
import android.content.Context;
import android.content.Intent;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class NoticeProjection {
  public static final int MAX_PAGE_BYTES = 256 * 1024;
  private static final Object CONTROL = new Object();
  private static NoticeProjection active;

  private final Context context;
  private final Class<?> tap;
  private final String owner;
  private final NativeNotificationInbox inbox;
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
  private volatile boolean retired;
  private long attempt;
  private int failures;
  private AgentChannel.Call live;
  private AutoCloseable ready;

  private interface Work { void run() throws Exception; }

  private NoticeProjection(Context context, Class<?> tap, String owner) throws IOException {
    this.context = context;
    this.tap = Objects.requireNonNull(tap);
    this.owner = owner;
    this.inbox = new NativeNotificationInbox(context.getNoBackupFilesDir().getCanonicalFile().toPath(), owner, this::post,
        NativeNotificationProjector::syncDirectory, this::authority);
  }

  public static String ownerOf(String userId, String organizationId) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(new JSONArray().put("eliza-notice-owner").put(organizationId).put(userId)
          .toString().getBytes(StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder();
      for (byte b : digest) hex.append(String.format("%02x", b));
      return hex.toString();
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new AssertionError(impossible);
    }
  }

  public static void bind(Context context, Class<?> tap, String userId, String organizationId) throws Exception {
    String next = userId == null || userId.isEmpty() ? null : ownerOf(userId, organizationId == null ? "" : organizationId);
    synchronized (CONTROL) {
      if (active != null && active.owner.equals(next)) return;
      NoticeProjection previous = active;
      active = null;
      if (previous != null) previous.retire();
      if (next == null) return;
      active = new NoticeProjection(context.getApplicationContext(), tap, next);
      active.start();
    }
  }

  public static boolean opened(Context context, Intent intent) {
    NoticeProjection current;
    synchronized (CONTROL) { current = active; }
    if (current == null) return NativeNotificationProjector.onOpened(context, Object.class, intent, null);
    return NativeNotificationProjector.onOpened(context, current.tap, intent, current.owner);
  }

  public static JSONObject status() throws Exception {
    NoticeProjection current;
    synchronized (CONTROL) { current = active; }
    return current == null ? new JSONObject().put("bound", false) : current.inbox.status().put("bound", true);
  }

  private void start() throws Exception {
    inbox.beginBaseline();
    ready = AgentService.onReady(() -> dispatch(-1, this::connect));
  }

  private void retire() throws IOException {
    retired = true;
    worker.shutdownNow();
    AgentChannel.Call subscription = live;
    if (subscription != null) subscription.close();
    try { if (ready != null) ready.close(); }
    catch (Exception ignored) { throw new IOException("Agent readiness observer could not be removed", ignored); }
    NativeNotificationProjector.retireOwner(context, owner);
  }

  private void authority() {
    if (retired) throw new SecurityException("Notice projection retired");
  }

  private boolean post(JSONObject notification) throws Exception {
    synchronized (CONTROL) {
      authority();
      boolean accepted = NativeNotificationProjector.post(context, tap, owner, notification);
      if (retired) NativeNotificationProjector.retireOwner(context, owner);
      authority();
      return accepted;
    }
  }

  private void connect() throws Exception {
    long current = ++attempt;
    AgentChannel.Call previous = live;
    if (previous != null) previous.close();
    live = AgentService.subscribe(Topic.NOTICES, listener(current));
    hydrate(current);
  }

  private AgentChannel.Listener listener(long current) {
    return new AgentChannel.Listener() {
      @Override public void head(String id, long index, int status, Map<String, String> headers) {}
      @Override public void chunk(String id, long index, byte[] data) {}
      @Override public void event(String id, long index, JSONObject event) {
        dispatch(current, () -> {
          JSONObject notification;
          try { notification = NativeNotificationWire.notification(event.toString()); }
          catch (JSONException | IllegalArgumentException invalid) { return; }
          if (notification != null) inbox.acceptLive(notification);
        });
      }
      @Override public void settled(String id, Outcome outcome, byte[] body) { dispatch(current, () -> fail(current)); }
    };
  }

  private void hydrate(long current) throws Exception {
    JSONObject cursor = inbox.pageCursor();
    AgentService.request("GET", NativeNotificationWire.pagePath(cursor), null).whenComplete((response, error) -> dispatch(current, () -> {
      if (error != null) { fail(current); return; }
      if (response.status() == 409 && cursor.has("nativeEpoch")) { inbox.restartEpoch(); hydrate(current); return; }
      if (response.status() < 200 || response.status() > 299 || response.body() == null || response.body().length > MAX_PAGE_BYTES) { fail(current); return; }
      if (!inbox.acceptPage(new JSONObject(new String(response.body(), StandardCharsets.UTF_8)), cursor)) { hydrate(current); return; }
      failures = 0;
    }));
  }

  private void fail(long current) {
    if (retired || current != attempt) return;
    ++attempt;
    AgentChannel.Call subscription = live;
    live = null;
    if (subscription != null) subscription.close();
    long ceiling = Math.min(60_000L, 1000L << Math.min(failures++, 6));
    long delay = ceiling / 2 + ThreadLocalRandom.current().nextLong(Math.max(1, ceiling / 2));
    long retried = attempt;
    try { worker.schedule(() -> dispatch(-1, () -> { if (retried == attempt && live == null) connect(); }), delay, TimeUnit.MILLISECONDS); }
    catch (RejectedExecutionException shutDown) { }
  }

  private void dispatch(long current, Work work) {
    try {
      worker.execute(() -> {
        if (retired || (current >= 0 && current != attempt)) return;
        try { work.run(); }
        catch (Exception failure) { fail(attempt); }
      });
    } catch (RejectedExecutionException shutDown) { }
  }
}
