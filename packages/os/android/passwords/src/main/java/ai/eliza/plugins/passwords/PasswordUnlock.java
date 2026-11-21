package ai.eliza.plugins.passwords;

import android.app.Activity;
import android.app.Application;
import android.app.KeyguardManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Looper;

/**
 * Platform BiometricPrompt that accepts a strong biometric or the device credential. Success
 * both authorizes the Keystore key's time-bound window and creates the in-process UI grant.
 * Nothing about the result is persisted.
 */
public final class PasswordUnlock {
  private PasswordUnlock() {}
  public interface Result { void unlocked(long ticket); void failed(String code); }

  /** The prompt belongs to one Activity and one challenge, including during recreation. */
  private static final class Pending implements Application.ActivityLifecycleCallbacks {
    final Activity activity;
    final PasswordVaultAccess access;
    final long ticket;
    final Result result;
    final CancellationSignal cancellation = new CancellationSignal();
    final PasswordSurfaces.Hold surface = PasswordSurfaces.open();
    boolean finished, legacyApproved;
    Pending(Activity activity, PasswordVaultAccess access, long ticket, Result result) {
      this.activity = activity; this.access = access; this.ticket = ticket; this.result = result;
      activity.getApplication().registerActivityLifecycleCallbacks(this);
    }
    void complete(boolean accepted, String code) {
      if (finished) return;
      if (accepted && access.deviceUnlockedCustody() && !access.activityCurrent(activity)
          && !activity.isFinishing() && !activity.isDestroyed()) {
        legacyApproved = true;
        return;
      }
      finished = true;
      activity.getApplication().unregisterActivityLifecycleCallbacks(this);
      try {
        boolean current = accepted && !activity.isFinishing() && !activity.isDestroyed();
        boolean granted = current && (access.deviceUnlockedCustody()
          ? access.finishLegacyAuthorization(activity, ticket) : access.complete(ticket, true));
        if (granted) {
          result.unlocked(ticket);
        } else {
          access.lock(ticket);
          cancellation.cancel();
          result.failed(code);
        }
      } catch (Exception unavailable) {
        access.lock(ticket);
        result.failed("migration-unavailable");
      } finally { surface.close(); }
    }
    @Override public void onActivityDestroyed(Activity owner) { if (owner == activity) complete(false, "cancelled"); }
    @Override public void onActivityStopped(Activity owner) { if (owner == activity && owner.isFinishing()) complete(false, "cancelled"); }
    @Override public void onActivityCreated(Activity owner, Bundle state) {}
    @Override public void onActivityStarted(Activity owner) {}
    @Override public void onActivityResumed(Activity owner) {
      if (owner == activity && legacyApproved) complete(true, "cancelled");
    }
    @Override public void onActivityPaused(Activity owner) {}
    @Override public void onActivitySaveInstanceState(Activity owner, Bundle state) {}
  }

  public static void prompt(Activity activity, Result result) {
    if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Unlock requires the main thread");
    if (activity.isFinishing() || activity.isDestroyed()) { result.failed("cancelled"); return; }
    PasswordVaultAccess access;
    try { access = PasswordVaultAccess.get(activity); } catch (Exception unavailable) { result.failed("unavailable"); return; }
    if (access.deviceUnlockedCustody() && !access.needsLegacyAuthorization()) {
      long ticket = access.openForeground(activity);
      if (ticket == 0) result.failed("unavailable"); else result.unlocked(ticket);
      return;
    }
    KeyguardManager keyguard = activity.getSystemService(KeyguardManager.class);
    if (keyguard == null || !keyguard.isDeviceSecure()) {
      result.failed(access.deviceUnlockedCustody() ? "migration-unavailable" : "no-screen-lock");
      return;
    }
    long ticket = access.begin();
    if (ticket == 0) { result.failed("busy"); return; }
    Pending pending = new Pending(activity, access, ticket, result);
    PasswordEditor.dismiss(); // The new challenge revoked the draft's admitting grant.
    try {
      BiometricPrompt.Builder builder = new BiometricPrompt.Builder(activity)
        .setTitle(activity.getString(R.string.eliza_passwords_unlock_title))
        .setSubtitle(activity.getString(R.string.eliza_passwords_unlock_subtitle));
      if (Build.VERSION.SDK_INT >= 30) {
        int authenticators = BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        if (access.config.biometric) authenticators |= BiometricManager.Authenticators.BIOMETRIC_STRONG;
        builder.setAllowedAuthenticators(authenticators);
      } else {
        builder.setDeviceCredentialAllowed(true);
      }
      builder.build().authenticate(pending.cancellation, activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
        @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult authenticated) {
          pending.complete(true, "cancelled");
        }
        @Override public void onAuthenticationError(int code, CharSequence message) {
          pending.complete(false, code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED ? "cancelled" : "unavailable");
        }
        // A single rejected biometric attempt keeps the prompt open; no state changes.
        @Override public void onAuthenticationFailed() {}
      });
    } catch (RuntimeException unavailable) {
      pending.complete(false, "unavailable");
    }
  }
}
