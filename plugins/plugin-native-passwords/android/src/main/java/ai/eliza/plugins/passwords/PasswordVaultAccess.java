package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.CredentialAccessSession;
import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import ai.eliza.plugins.securestore.nativeonly.PasswordVaultCustody;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.SystemClock;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.UserNotAuthenticatedException;
import java.io.File;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * Process-wide vault custody. Two independent gates protect every vault operation: an
 * ephemeral UI grant created only by a successful {@link PasswordUnlock} prompt, and the
 * selected Keystore policy. Legacy custody has an authentication window; the explicit
 * device-unlocked version checks device lock. UI grants and lifecycle fences remain required.
 */
public final class PasswordVaultAccess {
  public static final class Locked extends Exception { Locked() { super("Saved passwords are locked", null, false, false); } }
  public static final class KeyInvalidated extends Exception { KeyInvalidated() { super("Saved passwords can no longer be decrypted on this device", null, false, false); } }
  public interface Operation<T> { T run(PasswordVaultStore store) throws Exception; }

  private static PasswordVaultAccess instance;
  public static synchronized PasswordVaultAccess get(Context context) throws Exception {
    if (instance == null) instance = new PasswordVaultAccess(context, PasswordsConfig.of(context));
    return instance;
  }

  public final PasswordsConfig config;
  public final PasswordRequests requests = new PasswordRequests(SystemClock::elapsedRealtime, new SecureRandom());
  private final PasswordVaultStore store;
  private final CredentialAccessSession grant;
  private final PasswordVaultCustody custody;

  private PasswordVaultAccess(Context context, PasswordsConfig config) throws Exception {
    this.config = config;
    this.store = new PasswordVaultStore(config.directory, config.alias, config.aad, new PasswordVaultStore.KeyPolicy(config.unlockSeconds, config.biometric));
    File journal = new File(config.directory, "custody-selection");
    // Keep the old path unchanged until opt-in. A journal directory survives disabling
    // the resource, so an adopted host cannot silently fall back to the retained old vault.
    if (config.deviceUnlockedCustody || journal.exists()) {
      PasswordVaultStore device = new PasswordVaultStore(new File(config.directory, "device-unlocked-v1"),
          config.alias + ".device-unlocked-v1", config.aad, PasswordVaultStore.KeyPolicy.deviceUnlocked(context));
      custody = new PasswordVaultCustody(journal, store, device, config.deviceUnlockedCustody);
    } else custody = null;
    // The UI grant ends shortly before the Keystore window so the UI never reports an unlock
    // that the key itself would refuse.
    this.grant = new CredentialAccessSession(SystemClock::elapsedRealtime, Math.max(5000L, config.unlockSeconds * 1000L - 2000L));
  }

  public synchronized long begin() { return grant.begin(); }
  public synchronized boolean complete(long ticket, boolean accepted) { return grant.complete(ticket, accepted); }
  public synchronized boolean unlocked() { return grant.authenticated(); }
  public synchronized long ticket() { return grant.currentTicket(); }
  public synchronized boolean unlocked(long ticket) { return grant.authenticated(ticket); }
  public synchronized long remainingMillis() { return grant.remainingMillis(); }
  public synchronized boolean pending() { return grant.pending(); }
  public synchronized void lock() { grant.lock(); }
  public synchronized void lock(long ticket) { grant.lock(ticket); }

  public synchronized <T> T use(Operation<T> operation) throws Exception {
    return use(grant.currentTicket(), operation);
  }

  /** One operation starts under one live grant, serialized with lock and new challenges. */
  public synchronized <T> T use(long ticket, Operation<T> operation) throws Exception {
    if (!grant.authenticated(ticket)) throw new Locked();
    try {
      if (custody != null && config.deviceUnlockedCustody) custody.migrate();
      // Migration can outlive the UI grant. Never execute the requested operation on expiry.
      if (!grant.authenticated(ticket)) throw new Locked();
      T result = custody == null ? operation.run(store) : custody.use(selected -> {
        if (!grant.authenticated(ticket)) throw new Locked();
        return operation.run(selected);
      });
      if (!grant.authenticated(ticket)) throw new Locked();
      return result;
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
    long owner = grant.currentTicket();
    if (!grant.authenticated(owner)) throw new Locked();
    if (custody == null) store.resetUnrecoverable();
    else custody.use(selected -> {
      if (!grant.authenticated(owner)) throw new Locked();
      selected.resetUnrecoverable(); return null;
    });
    requests.clear();
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
