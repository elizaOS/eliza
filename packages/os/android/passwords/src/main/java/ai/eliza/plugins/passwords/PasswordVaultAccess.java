package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.CredentialAccessSession;
import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import java.io.File;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.UserNotAuthenticatedException;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * Process-wide native vault custody selected by the trusted Android host.
 */
public final class PasswordVaultAccess {
  static final class NotAdmitted extends Exception { NotAdmitted() { super("Saved passwords are not available here", null, false, false); } }
  public static final class Locked extends Exception { Locked() { super("Saved passwords are locked", null, false, false); } }
  public static final class KeyInvalidated extends Exception { KeyInvalidated() { super("Saved passwords can no longer be decrypted on this device", null, false, false); } }
  public interface Operation<T> { T run(PasswordVaultStore store) throws Exception; }
  /** The host's own rule for whether the vault may be reached now, for example its account owner. */
  public interface Admission { boolean admit(Context context); }

  private static volatile Admission admission = context -> true;
  /**
   * Registers the host's admission rule, once, from {@code Application#onCreate} (Android runs it
   * before it binds the Autofill service). Every bridge, Autofill and transfer entry to the vault
   * asks it first and refuses with {@code not-admitted}. It may run on the main thread (Autofill and
   * the fill and save screens) or the bridge thread, so it must be fast, must not show UI and
   * returns false when it cannot decide. The default admits.
   */
  public static void setAdmission(Admission rule) { admission = rule; }
  static boolean admitted(Context context) { return admission.admit(context); }

  private static final String DEVICE_CUSTODY = "device-unlocked-v1";
  private static boolean deviceCustodyInstalled;
  private static volatile Activity foreground;
  private static volatile PasswordVaultAccess instance;

  public static synchronized void installDeviceUnlockedCustody(Application app) {
    if (deviceCustodyInstalled) return;
    if (instance != null) throw new IllegalStateException("Password custody is already in use");
    deviceCustodyInstalled = true;
    app.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
      @Override public void onActivityResumed(Activity activity) {
        Activity previous = foreground;
        foreground = activity;
        PasswordVaultAccess access = instance;
        if (previous != null && previous != activity && access != null) access.closeForeground();
      }
      @Override public void onActivityPaused(Activity activity) {
        if (foreground != activity) return;
        foreground = null;
        PasswordVaultAccess access = instance;
        if (access != null) access.closeForeground();
      }
      @Override public void onActivityCreated(Activity activity, Bundle state) {}
      @Override public void onActivityStarted(Activity activity) {}
      @Override public void onActivityStopped(Activity activity) {}
      @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
      @Override public void onActivityDestroyed(Activity activity) {}
    });
  }
  public static synchronized PasswordVaultAccess get(Context context) throws Exception {
    if (instance == null) instance = new PasswordVaultAccess(context, PasswordsConfig.of(context));
    return instance;
  }

  public final PasswordsConfig config;
  public final PasswordRequests requests = new PasswordRequests(SystemClock::elapsedRealtime, new SecureRandom());
  private final PasswordVaultStore store;
  private final CredentialAccessSession grant;
  private final PasswordVaultStore legacyStore;
  private final SharedPreferences custody;
  private final Context context;

  private PasswordVaultAccess(Context context, PasswordsConfig config) throws Exception {
    this.context = context.getApplicationContext();
    this.config = config;
    PasswordVaultStore original = new PasswordVaultStore(config.directory, config.alias, config.aad,
        new PasswordVaultStore.KeyPolicy(config.unlockSeconds, config.biometric));
    if (deviceCustodyInstalled) {
      legacyStore = original;
      store = new PasswordVaultStore(new File(config.directory, DEVICE_CUSTODY), config.alias + "." + DEVICE_CUSTODY,
          config.aad, PasswordVaultStore.KeyPolicy.deviceUnlocked(this.context));
      custody = this.context.getSharedPreferences("eliza.passwords.custody", Context.MODE_PRIVATE);
      grant = CredentialAccessSession.foregroundWindow();
    } else {
      legacyStore = null;
      store = original;
      custody = null;
      grant = new CredentialAccessSession(SystemClock::elapsedRealtime, Math.max(5000L, config.unlockSeconds * 1000L - 2000L));
    }
  }

  public boolean deviceUnlockedCustody() { return custody != null; }
  public boolean needsLegacyAuthorization() {
    return deviceUnlockedCustody() && legacyStore.exists() && !custody.getBoolean(config.alias, false);
  }
  boolean activityCurrent(Activity activity) { return activity != null && foreground == activity && !activity.isFinishing() && !activity.isDestroyed(); }
  boolean ownerForeground() {
    Activity owner = foreground;
    return owner != null && activityCurrent(owner) && PasswordVaultStore.deviceUnlockedNow(context) && admitted(context);
  }
  String blockedDeviceReason() {
    if (!admitted(context)) return "not-admitted";
    if (!ownerForeground()) return "device-locked";
    return needsLegacyAuthorization() ? legacyReason() : null;
  }
  String legacyReason() {
    try { return legacyStore.unrecoverable() ? "legacy-key-unavailable" : "legacy-authorization-required"; }
    catch (Exception unavailable) { return "legacy-authorization-required"; }
  }
  public boolean deviceWindowOpen() { return ownerForeground() && !needsLegacyAuthorization(); }

  synchronized long openForeground(Activity activity) {
    if (!activityCurrent(activity) || !deviceWindowOpen()) return 0;
    long ticket = grant.begin();
    return grant.complete(ticket, true) ? ticket : 0;
  }
  synchronized boolean finishLegacyAuthorization(Activity activity, long ticket) throws Exception {
    if (!activityCurrent(activity) || !ownerForeground() || !grant.pending(ticket) || !needsLegacyAuthorization()) return false;
    legacyStore.migrateToDeviceUnlocked(store);
    if (!activityCurrent(activity) || !ownerForeground()) return false;
    if (!custody.edit().putBoolean(config.alias, true).commit()) throw new java.io.IOException("Password custody could not be selected");
    return grant.complete(ticket, true);
  }
  private void closeForeground() {
    synchronized (this) { grant.stop(); }
    PasswordEditor.dismiss();
    SecretSurfaces.dismiss();
  }

  public synchronized long begin() { return grant.begin(); }
  public synchronized boolean complete(long ticket, boolean accepted) { return grant.complete(ticket, accepted); }
  public synchronized boolean unlocked() { return deviceUnlockedCustody() ? deviceWindowOpen() : grant.authenticated(); }
  public synchronized long ticket() {
    if (deviceUnlockedCustody()) {
      Activity owner = foreground;
      if (owner == null || !deviceWindowOpen()) return 0;
      if (!grant.authenticated()) return openForeground(owner);
    }
    return grant.currentTicket();
  }
  public synchronized boolean unlocked(long ticket) { return unlocked() && grant.authenticated(ticket); }
  public synchronized long remainingMillis() { return grant.remainingMillis(); }
  public synchronized boolean pending() { return grant.pending(); }
  public synchronized void lock() { grant.lock(); }
  public synchronized void lock(long ticket) { grant.lock(ticket); }

  /**
   * For the host's native lifecycle (for example a sign-out): locks, drops pending fill and save
   * requests, closes the editor and a revealed password, and expires the retiring owner's clipboard
   * lease. Open fill and save screens and a pending unlock fail on their next step.
   */
  public void lockAndClose() {
    synchronized (this) {
      grant.lock();
      requests.clear();
      SecretSurfaces.retireClipboard();
    }
    closeSurfaces();
  }

  /** Whether records are stored. Needs no grant and shows no prompt. */
  public boolean exists() { return store.exists() || needsLegacyAuthorization(); }
  /** Whether stored records can never be decrypted again (see {@link #resetUnrecoverable}). Needs no grant. */
  public boolean unrecoverable() throws Exception { return !needsLegacyAuthorization() && store.unrecoverable(); }

  static void closeSurfaces() {
    Runnable dismissReveal = SecretSurfaces.currentDismissal();
    Runnable close = () -> { PasswordEditor.dismissLocked(); dismissReveal.run(); };
    if (Looper.myLooper() == Looper.getMainLooper()) close.run();
    else new Handler(Looper.getMainLooper()).post(close);
  }

  synchronized <T> T useForOwner(Context context, long ticket, Operation<T> delivery) throws Exception {
    if (!unlocked(ticket)) throw new Locked();
    if (!admitted(context)) throw new NotAdmitted();
    return use(ticket, delivery);
  }

  public synchronized <T> T use(Operation<T> operation) throws Exception {
    return use(ticket(), operation);
  }

  /** One operation starts under one live grant, serialized with lock and new challenges. */
  public synchronized <T> T use(long ticket, Operation<T> operation) throws Exception {
    if (!unlocked(ticket)) throw new Locked();
    try {
      T value = operation.run(store);
      if (deviceUnlockedCustody() && !unlocked(ticket)) throw new Locked();
      return value;
    }
    catch (UserNotAuthenticatedException expired) { lock(); throw new Locked(); }
    catch (KeyPermanentlyInvalidatedException | PasswordVaultStore.KeyLost invalidated) { lock(); throw new KeyInvalidated(); }
    catch (Exception failure) {
      Throwable cause = failure.getCause();
      if (cause instanceof UserNotAuthenticatedException) { lock(); throw new Locked(); }
      if (cause instanceof KeyPermanentlyInvalidatedException) { lock(); throw new KeyInvalidated(); }
      throw failure;
    }
  }

  /**
   * After the key is lost or invalidated the vault can never be read again. With a fresh unlock,
   * the user may delete it and start over; a readable vault is never deleted here.
   */
  public synchronized void resetUnrecoverable() throws Exception {
    if (!unlocked() || needsLegacyAuthorization()) throw new Locked();
    store.resetUnrecoverable();
    requests.clear();
  }

  /**
   * Destroys the vault, readable or not, with no prompt and no grant: revokes the grant and
   * pending requests, deletes the key and the records, then closes open native surfaces. For the
   * host's native lifecycle after it has verified its own authority (for example an owner revoke).
   * This is deliberately not a {@code PluginMethod}: page script must not reach it. A clip from
   * this vault expires immediately. Throws if deletion failed; call it again to finish.
   */
  public void destroyVault() throws Exception {
    try {
      synchronized (this) {
        grant.lock();
        requests.clear();
        SecretSurfaces.retireClipboard();
        store.destroy();
        if (legacyStore != null) legacyStore.destroy();
      }
    } finally { closeSurfaces(); }
  }

  /** Current signer digest for a newly captured app binding; null when ambiguous or unavailable. */
  static String currentSigner(Context context, String packageName) {
    try {
      PackageInfo info = context.getPackageManager().getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES);
      if (info.signingInfo == null || info.signingInfo.hasMultipleSigners()) return null;
      Signature[] history = info.signingInfo.getSigningCertificateHistory();
      if (history == null || history.length == 0) return null;
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(history[history.length - 1].toByteArray());
      StringBuilder out = new StringBuilder(64);
      for (byte value : digest) out.append(Character.forDigit((value >> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
      return out.toString();
    } catch (Exception unavailable) { return null; }
  }
}
