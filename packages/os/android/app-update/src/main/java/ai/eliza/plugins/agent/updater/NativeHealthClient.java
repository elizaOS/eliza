// spec/os/appUpdate/health.md, "Evidence names the installation it was asked about and is sent only before the deadline of an open service"; spec/os/appUpdate/health.md, "Only a well-timed updater request for this version starts the worker"
package ai.eliza.plugins.agent.updater;

import ai.eliza.plugins.agent.health.HealthWork;
import ai.eliza.plugins.agent.health.NativeHealthEvidence;
import ai.eliza.plugins.agent.health.NativeHealthService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.SystemClock;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public final class NativeHealthClient {
  private NativeHealthClient() {}

  public static Optional<NativeHealthEvidence> read(Context context, String target, String serviceClass, NativeHealthEvidence.Subject subject, long requestBudgetMillis) throws Exception {
    if (requestBudgetMillis <= 0 || requestBudgetMillis > HealthWork.MAX_REQUEST_MS) throw new IllegalArgumentException("Health request budget must be positive and at most 20 s");
    if (Looper.myLooper() == Looper.getMainLooper()) throw new IOException("Health probe cannot block the main thread");
    Objects.requireNonNull(target); Objects.requireNonNull(serviceClass); Objects.requireNonNull(subject);
    PackageManager packages = context.getPackageManager();
    if (packages.checkSignatures(context.getPackageName(), target) != PackageManager.SIGNATURE_MATCH) throw new IOException("Health peer signer mismatch");
    UpdateJournal.Identity before = PackageInstallCoordinator.installed(context, target);
    int expectedUid = packages.getApplicationInfo(target, 0).uid;
    if (before.code != subject.versionCode || !before.digest.equals(subject.installed))
      throw new IOException("Installed app does not match the requested health subject");
    String nonce = nonce();
    long started = SystemClock.elapsedRealtime(), deadline = Math.addExact(started, requestBudgetMillis);
    CompletableFuture<IBinder> connection = new CompletableFuture<>();
    CompletableFuture<Optional<NativeHealthEvidence>> response = new CompletableFuture<>();
    HandlerThread thread = new HandlerThread("AppUpdateHealthReply");
    thread.start();
    Messenger replies = new Messenger(new Handler(thread.getLooper(), message -> {
      try {
        if (message.sendingUid != expectedUid) throw new IOException("Health reply UID mismatch");
        if (message.what == NativeHealthService.UNAVAILABLE) response.complete(Optional.empty());
        else if (message.what != NativeHealthService.OBSERVED) throw new IOException("Health request refused: " + message.what);
        else response.complete(Optional.of(NativeHealthEvidence.parse(message.getData().getString("body"), nonce, subject, started, SystemClock.elapsedRealtime(), deadline)));
      } catch (Exception error) {
        response.completeExceptionally(error);
      }
      return true;
    }));
    ServiceConnection callbacks = new ServiceConnection() {
      @Override public void onServiceConnected(ComponentName name, IBinder binder) { connection.complete(binder); }
      @Override public void onServiceDisconnected(ComponentName name) { response.completeExceptionally(new IOException("Health peer disconnected")); }
      @Override public void onNullBinding(ComponentName name) { connection.completeExceptionally(new IOException("Health binding unavailable")); }
      @Override public void onBindingDied(ComponentName name) {
        connection.completeExceptionally(new IOException("Health binding died"));
        response.completeExceptionally(new IOException("Health binding died"));
      }
    };
    boolean bound = false;
    try {
      bound = context.bindService(new Intent().setComponent(new ComponentName(target, serviceClass)), callbacks, Context.BIND_AUTO_CREATE);
      if (!bound) throw new IOException("Health service unavailable");
      IBinder binder = connection.get(remaining(deadline), TimeUnit.MILLISECONDS);
      Message request = Message.obtain();
      request.what = NativeHealthService.REQUEST;
      request.replyTo = replies;
      request.setData(request(nonce, deadline, subject));
      new Messenger(binder).send(request);
      Optional<NativeHealthEvidence> result = response.get(remaining(deadline), TimeUnit.MILLISECONDS);
      UpdateJournal.Identity after = PackageInstallCoordinator.installed(context, target);
      if (!before.matches(after) || SystemClock.elapsedRealtime() >= deadline || packages.getApplicationInfo(target, 0).uid != expectedUid)
        throw new IOException("Installed health subject changed or expired");
      return result;
    } finally {
      try { if (bound) context.unbindService(callbacks); } finally { thread.quitSafely(); }
    }
  }

  static Bundle request(String nonce, long deadline, NativeHealthEvidence.Subject subject) {
    Bundle data = new Bundle();
    data.putString("nonce", nonce);
    data.putLong("versionCode", subject.versionCode);
    data.putLong("deadlineElapsed", deadline);
    data.putString("planId", subject.planId);
    data.putLong("generation", subject.generation);
    data.putLong("revision", subject.revision);
    data.putString("installed", subject.installed);
    return data;
  }

  private static String nonce() {
    byte[] random = new byte[32];
    new SecureRandom().nextBytes(random);
    StringBuilder text = new StringBuilder();
    for (byte b : random) text.append(String.format(Locale.ROOT, "%02x", b & 255));
    return text.toString();
  }

  private static long remaining(long deadline) throws IOException {
    long left = deadline - SystemClock.elapsedRealtime();
    if (left <= 0) throw new IOException("Health request expired");
    return left;
  }
}
