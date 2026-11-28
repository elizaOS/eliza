// spec/os/appUpdate/health.md, "Only a well-timed updater request for this version starts the worker"; spec/os/appUpdate/health.md, "Only a failing agent fails an update, and a pass needs a ready agent, its storage and visible content of the same launch"; spec/os/appUpdate/health.md, "Evidence names the installation it was asked about and is sent only before the deadline of an open service"
package ai.eliza.plugins.agent.health;

import ai.eliza.plugins.agent.health.HealthWork.Admission;
import ai.eliza.plugins.agent.health.HealthWork.Screen;
import ai.eliza.plugins.agent.health.HealthWork.Verdict;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.os.SystemClock;
import android.util.Log;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

public abstract class NativeHealthService extends Service {
  public static final int REQUEST = 1;
  public static final int OBSERVED = 200;
  public static final int INVALID_OR_BUSY = 400;
  public static final int UNAUTHORIZED = 403;
  public static final int UNAVAILABLE = 503;
  private static final String TAG = "AppUpdateHealth";

  protected abstract String supervisorPackage();
  protected abstract long versionCode();
  protected abstract LocalRuntimeHealth.AgentPort agent();
  protected abstract WebViewHealthObserver observer();

  private static final class Request {
    final String nonce;
    final long deadline;
    final NativeHealthEvidence.Subject subject;
    Request(String nonce, long deadline, NativeHealthEvidence.Subject subject) {
      this.nonce = nonce; this.deadline = deadline; this.subject = subject;
    }
  }

  private final ExecutorService worker = Executors.newSingleThreadExecutor(task -> new Thread(task, TAG));
  private final AtomicBoolean busy = new AtomicBoolean();
  private final Messenger inbound = new Messenger(new Handler(Looper.getMainLooper(), this::receive));
  private volatile boolean closed;

  @Override public IBinder onBind(Intent intent) { return inbound.getBinder(); }

  @Override public void onDestroy() {
    closed = true;
    worker.shutdownNow();
    super.onDestroy();
  }

  private boolean supervisor(int uid) {
    PackageManager packages = getPackageManager();
    String[] names = packages.getPackagesForUid(uid);
    return names != null && names.length == 1 && supervisorPackage().equals(names[0])
      && packages.checkSignatures(uid, android.os.Process.myUid()) == PackageManager.SIGNATURE_MATCH;
  }

  private boolean receive(Message message) {
    Messenger destination = message.replyTo;
    if (!supervisor(message.sendingUid)) { reply(destination, UNAUTHORIZED, "unauthorized"); return true; }
    Optional<Request> request = message.what == REQUEST ? parse(message.getData()) : Optional.empty();
    long now = SystemClock.elapsedRealtime();
    boolean admitted = request.isPresent()
      && HealthWork.admission(true, !closed && !busy.get(), request.get().subject.versionCode, versionCode(), request.get().deadline, now) == Admission.ADMITTED
      && busy.compareAndSet(false, true);
    if (!admitted) { reply(destination, INVALID_OR_BUSY, "invalid_or_busy"); return true; }
    worker.execute(() -> {
      try { answer(destination, request.get()); } finally { busy.set(false); }
    });
    return true;
  }

  private static Optional<Request> parse(Bundle data) {
    if (data == null || !data.keySet().equals(NativeHealthEvidence.REQUEST_KEYS)) return Optional.empty();
    Object nonce = data.get("nonce"), version = data.get("versionCode"), deadline = data.get("deadlineElapsed");
    Object plan = data.get("planId"), generation = data.get("generation"), revision = data.get("revision"), installed = data.get("installed");
    if (!(nonce instanceof String n) || !n.matches(NativeHealthEvidence.NONCE) || !(version instanceof Long v) || !(deadline instanceof Long d)
        || !(plan instanceof String p) || !(generation instanceof Long g) || !(revision instanceof Long r) || !(installed instanceof String i))
      return Optional.empty();
    try {
      return Optional.of(new Request(n, d, new NativeHealthEvidence.Subject(p, g, r, v, i)));
    } catch (IllegalArgumentException invalid) {
      return Optional.empty();
    }
  }

  private void answer(Messenger destination, Request request) {
    try {
      long left = request.deadline - SystemClock.elapsedRealtime();
      if (closed || left <= 0) return;
      LocalRuntimeHealth runtime = new LocalRuntimeHealth(agent(), Math.toIntExact(left));
      LocalRuntimeHealth.Reading reading = runtime.readBefore(request.deadline);
      Screen screen = screen(observer(), HealthWork.uiDeadline(SystemClock.elapsedRealtime(), request.deadline));
      Optional<Verdict> verdict = HealthWork.conclude(reading.agent, reading.storage, screen, runtime.sameLaunch(reading));
      long observed = SystemClock.elapsedRealtime();
      if (closed || observed >= request.deadline) return;
      if (verdict.isEmpty()) reply(destination, UNAVAILABLE, "unavailable");
      else reply(destination, OBSERVED, new NativeHealthEvidence(request.subject, verdict.get()).encode(request.nonce, observed));
    } catch (RuntimeException failure) {
      Log.e(TAG, "Health evaluation failed", failure);
      if (!closed && SystemClock.elapsedRealtime() < request.deadline) reply(destination, UNAVAILABLE, "unavailable");
    }
  }

  private static Screen screen(WebViewHealthObserver observer, long deadline) {
    try {
      JSONObject seen = observer.read(deadline);
      return switch (seen.getString("activityState")) {
        case "absent" -> Screen.ABSENT;
        case "background" -> Screen.BACKGROUND;
        case "foreground" -> seen.getBoolean("contentPresent") ? Screen.CONTENT : Screen.EMPTY;
        default -> Screen.FAILED;
      };
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      return Screen.FAILED;
    } catch (Exception failed) {
      return Screen.FAILED;
    }
  }

  private static void reply(Messenger destination, int code, String body) {
    if (destination == null) return;
    Message message = Message.obtain();
    message.what = code;
    Bundle data = new Bundle();
    data.putString("body", body);
    message.setData(data);
    try {
      destination.send(message);
    } catch (RemoteException gone) {
      Log.w(TAG, "Health reply undelivered", gone);
    }
  }
}
