package ai.eliza.plugins.securestore.nativeonly;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

// spec/os/android/taskKeys.md, "Each account has at most one task key, and a stored key is never replaced"; spec/os/android/taskKeys.md, "The current account's key is released only as the storage key of a launch newer than every earlier one"; spec/os/android/taskKeys.md, "An account change, a sign-out or a reset retires the release"
public final class TaskKeyCustody {
  static final String STORE = "agent-tasks";

  public static final class Account {
    public final String userId;
    public final String organizationId;

    public Account(String userId, String organizationId) {
      if (!present(userId) || !present(organizationId)) throw new IllegalArgumentException("Invalid task key account");
      this.userId = userId;
      this.organizationId = organizationId;
    }

    @Override public boolean equals(Object other) {
      return other instanceof Account && ((Account) other).userId.equals(userId)
          && ((Account) other).organizationId.equals(organizationId);
    }

    @Override public int hashCode() { return Objects.hash(userId, organizationId); }

    @Override public String toString() { return "Account(" + userId + ", " + organizationId + ")"; }

    private static boolean present(String value) { return value != null && !value.isEmpty() && value.length() <= 256; }
  }

  public enum Refusal { NotVerifiedAccount, StaleEpoch, KeyUnavailable }

  public static final class ReleaseRefused extends Exception {
    private static final long serialVersionUID = 1L;
    public final Refusal refusal;

    ReleaseRefused(Refusal refusal, Throwable cause) {
      super("Task key release refused: " + refusal, cause);
      this.refusal = refusal;
    }
  }

  public static final class StorageKey implements AutoCloseable {
    public final long epoch;
    private byte[] text;

    private StorageKey(long epoch, byte[] text) {
      this.epoch = epoch;
      this.text = text;
    }

    public synchronized String value() {
      if (text == null) throw new IllegalStateException("Storage key is retired");
      return new String(text, StandardCharsets.US_ASCII);
    }

    public synchronized boolean retired() { return text == null; }

    @Override public synchronized void close() {
      if (text != null) Arrays.fill(text, (byte) 0);
      text = null;
    }

    @Override public String toString() { return "StorageKey(epoch=" + epoch + ")"; }
  }

  private final TaskDataKeyStore keys;
  private final String authority;
  private final Map<Account, String> knownKeys = new HashMap<>();
  private Account verified;
  private long lastEpoch;
  private StorageKey release;

  public TaskKeyCustody(File directory, String aliasPrefix, String authority) {
    this(TaskDataKeyStore.perSlot(directory, aliasPrefix, false), authority);
  }

  TaskKeyCustody(TaskDataKeyStore keys, String authority) {
    if (!keys.isPerSlot()) throw new IllegalArgumentException("Task key custody requires per-slot keys");
    if (authority == null || authority.isEmpty()) throw new IllegalArgumentException("Invalid task key authority");
    this.keys = keys;
    this.authority = authority;
  }

  public synchronized void accountVerified(Account account) {
    Objects.requireNonNull(account);
    if (account.equals(verified)) return;
    verified = account;
    retire();
  }

  public synchronized void signedOut() {
    verified = null;
    retire();
  }

  public synchronized void reset() {
    verified = null;
    retire();
  }

  public synchronized StorageKey releaseForLaunch(Account account, long epoch) throws ReleaseRefused {
    Objects.requireNonNull(account);
    if (!account.equals(verified)) throw new ReleaseRefused(Refusal.NotVerifiedAccount, null);
    if (epoch < 1 || epoch <= lastEpoch) throw new ReleaseRefused(Refusal.StaleEpoch, null);
    lastEpoch = epoch;
    retire();
    String known = knownKeys.get(account);
    try (TaskDataKeyStore.Key key = readOrCreate(ownerIdentity(account), known)) {
      if (known != null && !known.equals(key.id)) throw new IllegalStateException("Task key was replaced");
      knownKeys.put(account, key.id);
      byte[] bytes = key.copyBytes();
      try {
        release = new StorageKey(epoch, Base64.getEncoder().encode(bytes));
        return release;
      } finally { Arrays.fill(bytes, (byte) 0); }
    } catch (Exception unreadable) {
      throw new ReleaseRefused(Refusal.KeyUnavailable, unreadable);
    }
  }

  private TaskDataKeyStore.Key readOrCreate(String owner, String known) throws Exception {
    TaskDataKeyStore.Key stored = keys.read(owner, STORE);
    if (stored != null) return stored;
    if (known != null) throw new IllegalStateException("Task key is missing");
    return keys.createIfAbsent(owner, STORE);
  }

  String ownerIdentity(Account account) throws Exception {
    return VerifiedOwnerIdentity.of(authority, account.userId, account.organizationId);
  }

  private void retire() {
    if (release != null) release.close();
    release = null;
  }
}
