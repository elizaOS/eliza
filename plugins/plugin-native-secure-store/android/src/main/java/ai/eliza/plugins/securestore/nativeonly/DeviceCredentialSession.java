package ai.eliza.plugins.securestore.nativeonly;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Bundle;
import android.os.Looper;
import android.os.SystemClock;
import java.util.function.LongSupplier;

/** Native-only Activity adapter. Hosts own views, strings and request-code reservation. */
public final class DeviceCredentialSession implements AutoCloseable {
  public enum Unavailable { DEVICE_LOCK_REQUIRED, CHALLENGE_UNAVAILABLE }
  public interface Listener {
    void locked();
    void unavailable(Unavailable reason);
  }
  interface Challenge {
    boolean secure();
    Intent create(CharSequence title, CharSequence message);
    void launch(Intent intent, int code);
  }
  private static final class AndroidChallenge implements Challenge {
    private final Activity activity;
    AndroidChallenge(Activity activity) {
      if (activity == null) throw new IllegalArgumentException("Missing Activity");
      this.activity = activity;
    }
    public boolean secure() {
      KeyguardManager keyguard = activity.getSystemService(KeyguardManager.class);
      return keyguard != null && keyguard.isDeviceSecure();
    }
    public Intent create(CharSequence title, CharSequence message) {
      KeyguardManager keyguard = activity.getSystemService(KeyguardManager.class);
      return keyguard == null ? null : keyguard.createConfirmDeviceCredentialIntent(title, message);
    }
    public void launch(Intent intent, int code) { activity.startActivityForResult(intent, code); }
  }
  private final Challenge challenge;
  private final Listener listener;
  private final NativeDeadlineTimer timer = new NativeDeadlineTimer();
  private final CredentialAccessSession access;
  private final int firstCode, lastCode;
  private final String stateKey;
  private int nextCode, requestCode = -1;
  private long ticket;
  private Runnable continuation;
  private boolean closed;

  /** Codes in the inclusive range must be reserved by the host for this Activity instance. */
  public DeviceCredentialSession(Activity activity, long durationMillis, int firstCode, int lastCode, Bundle savedState, Listener listener) {
    this(new AndroidChallenge(activity), durationMillis, firstCode, lastCode, savedState, listener, SystemClock::elapsedRealtime);
  }

  DeviceCredentialSession(Challenge challenge, long durationMillis, int firstCode, int lastCode, Bundle savedState, Listener listener, LongSupplier clock) {
    if (challenge == null || listener == null || firstCode < 0 || lastCode < firstCode || lastCode > 65535)
      throw new IllegalArgumentException("Invalid device authentication host");
    this.challenge = challenge;
    this.listener = listener;
    this.firstCode = firstCode;
    this.stateKey = "eliza.deviceCredential.nextCode." + firstCode;
    this.nextCode = savedState == null ? firstCode : savedState.getInt(stateKey, lastCode + 1);
    if (this.nextCode < firstCode || this.nextCode > lastCode + 1) this.nextCode = lastCode + 1;
    this.lastCode = lastCode;
    this.access = new CredentialAccessSession(clock, durationMillis);
  }

  private void mainThread() {
    if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Device authentication requires the main thread");
  }

  public void authenticate(CharSequence title, CharSequence message, Runnable next) {
    mainThread();
    if (closed || access.pending()) return;
    if (next == null) throw new IllegalArgumentException("Missing authentication destination");
    // Never wrap request codes: an old platform result must not become a new grant.
    if (nextCode > lastCode) { lock(); listener.unavailable(Unavailable.CHALLENGE_UNAVAILABLE); return; }
    try {
      if (!challenge.secure()) { lock(); listener.unavailable(Unavailable.DEVICE_LOCK_REQUIRED); return; }
      Intent intent = challenge.create(title, message);
      if (intent == null) { lock(); listener.unavailable(Unavailable.CHALLENGE_UNAVAILABLE); return; }
      timer.cancel();
      ticket = access.begin();
      if (ticket == 0) return;
      continuation = next;
      requestCode = nextCode++;
      challenge.launch(intent, requestCode);
    } catch (RuntimeException unavailable) { lock(); listener.unavailable(Unavailable.CHALLENGE_UNAVAILABLE); }
  }

  /** Returns true for a result in the reserved range, including stale/duplicate results. */
  public boolean onActivityResult(int code, int result) {
    mainThread();
    if (code >= firstCode && code <= lastCode) {
      if (closed || code != requestCode || !access.pending()) return true;
      Runnable next = continuation;
      continuation = null;
      requestCode = -1;
      if (!access.complete(ticket, result == Activity.RESULT_OK) || next == null) { lock(); return true; }
      ticket = 0;
      timer.watch(access::remainingMillis, this::lock);
      // Arming can expire synchronously; never enter the unlocked destination then.
      if (authenticated()) next.run();
      return true;
    }
    return false;
  }

  /** Save only a monotone request-code watermark; never a pending continuation or grant. */
  public void saveState(Bundle state) {
    mainThread();
    state.putInt(stateKey, nextCode);
  }

  public boolean challengePending() { mainThread(); return access.pending(); }

  public boolean authenticated() {
    mainThread();
    boolean allowed = access.authenticated();
    if (!allowed && !closed && !access.pending()) lock();
    return allowed;
  }

  public void lock() {
    mainThread();
    access.lock(); ticket = 0; requestCode = -1; continuation = null;
    timer.cancel();
    if (!closed) listener.locked();
  }

  public void onStop() {
    mainThread();
    if (closed) return;
    access.stop(); timer.cancel();
    if (!access.pending()) { ticket = 0; requestCode = -1; continuation = null; }
    listener.locked();
  }

  @Override public void close() {
    mainThread(); closed = true; access.close(); ticket = 0; requestCode = -1; continuation = null;
    timer.close();
  }
}
