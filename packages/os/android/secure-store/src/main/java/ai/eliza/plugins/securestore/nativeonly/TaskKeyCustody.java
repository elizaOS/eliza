package ai.eliza.plugins.securestore.nativeonly;

import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.Iterator;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.UUID;
import org.json.JSONObject;

// spec/os/android/taskKeys.md, "Each account has at most one task key, and a stored key is never replaced"; spec/os/android/taskKeys.md, "The current account's key is released only as the storage key of a launch newer than every earlier one"; spec/os/android/taskKeys.md, "An account change, a sign-out or a reset retires the release"
public final class TaskKeyCustody {
  static final String STORE = "agent-tasks";
  private static final String RECORD = "task-key-custody-v1";

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

  private static final class Record {
    long lastEpoch;
    final Map<String, String> owners = new TreeMap<>();
  }

  private final File records;
  private final TaskDataKeyStore keys;
  private final String authority;
  private Account verified;
  private long lastEpoch;
  private StorageKey release;

  public TaskKeyCustody(File directory, String aliasPrefix, String authority) {
    this(directory, TaskDataKeyStore.perSlot(directory, aliasPrefix, false), authority);
  }

  TaskKeyCustody(File records, TaskDataKeyStore keys, String authority) {
    if (!keys.isPerSlot()) throw new IllegalArgumentException("Task key custody requires per-slot keys");
    if (authority == null || authority.isEmpty()) throw new IllegalArgumentException("Invalid task key authority");
    this.records = Objects.requireNonNull(records);
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

  public synchronized void reset() throws Exception {
    verified = null;
    lastEpoch = 0;
    retire();
    Record held = load();
    for (String owner : held.owners.keySet()) keys.destroy(owner, STORE);
    AtomicFile file = record();
    file.delete();
    if (exists(file)) throw new IllegalStateException("Task key custody record could not be removed");
  }

  public synchronized StorageKey releaseForLaunch(Account account, long epoch) throws ReleaseRefused {
    Objects.requireNonNull(account);
    if (!account.equals(verified)) throw new ReleaseRefused(Refusal.NotVerifiedAccount, null);
    if (epoch < 1 || epoch <= lastEpoch) throw new ReleaseRefused(Refusal.StaleEpoch, null);
    Record held;
    try { held = load(); }
    catch (Exception unreadable) {
      lastEpoch = epoch;
      retire();
      throw new ReleaseRefused(Refusal.KeyUnavailable, unreadable);
    }
    if (epoch <= held.lastEpoch) {
      lastEpoch = held.lastEpoch;
      throw new ReleaseRefused(Refusal.StaleEpoch, null);
    }
    lastEpoch = epoch;
    retire();
    try {
      String owner = ownerIdentity(account);
      String known = held.owners.get(owner);
      boolean first = known == null || known.isEmpty();
      held.lastEpoch = epoch;
      if (known == null) held.owners.put(owner, "");
      keep(held);
      try (TaskDataKeyStore.Key key = readOrCreate(owner, !first)) {
        if (!first && !known.equals(key.id)) throw new IllegalStateException("Task key was replaced");
        if (first) {
          held.owners.put(owner, key.id);
          keep(held);
        }
        byte[] bytes = key.copyBytes();
        try {
          release = new StorageKey(epoch, Base64.getEncoder().encode(bytes));
          return release;
        } finally { Arrays.fill(bytes, (byte) 0); }
      }
    } catch (Exception unreadable) {
      throw new ReleaseRefused(Refusal.KeyUnavailable, unreadable);
    }
  }

  private TaskDataKeyStore.Key readOrCreate(String owner, boolean known) throws Exception {
    TaskDataKeyStore.Key stored = keys.read(owner, STORE);
    if (stored != null) return stored;
    if (known) throw new IllegalStateException("Task key is missing");
    return keys.createIfAbsent(owner, STORE);
  }

  private AtomicFile record() { return new AtomicFile(new File(records, RECORD)); }

  private static boolean exists(AtomicFile file) {
    return file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists();
  }

  private Record load() throws Exception {
    Record held = new Record();
    AtomicFile file = record();
    if (!exists(file)) return held;
    JSONObject json = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
    if (json.getInt("version") != 1) throw new IllegalStateException("Unknown task key custody record");
    held.lastEpoch = json.getLong("lastEpoch");
    if (held.lastEpoch < 0) throw new IllegalStateException("Invalid task key custody record");
    JSONObject owners = json.getJSONObject("owners");
    for (Iterator<String> names = owners.keys(); names.hasNext(); ) {
      String owner = names.next();
      String id = owners.getString(owner);
      if (!id.isEmpty() && !UUID.fromString(id).toString().equals(id)) throw new IllegalStateException("Invalid task key custody record");
      held.owners.put(owner, id);
    }
    return held;
  }

  private void keep(Record held) throws Exception {
    JSONObject owners = new JSONObject();
    for (Map.Entry<String, String> entry : held.owners.entrySet()) owners.put(entry.getKey(), entry.getValue());
    byte[] text = new JSONObject().put("version", 1).put("lastEpoch", held.lastEpoch).put("owners", owners).toString()
        .getBytes(StandardCharsets.UTF_8);
    AtomicFile file = record();
    FileOutputStream out = file.startWrite();
    try {
      out.write(text);
      file.finishWrite(out);
    } catch (Exception failed) {
      file.failWrite(out);
      throw failed;
    }
    Record committed = load();
    if (committed.lastEpoch != held.lastEpoch || !committed.owners.equals(held.owners))
      throw new IllegalStateException("Task key custody record unavailable");
  }

  String ownerIdentity(Account account) throws Exception {
    return VerifiedOwnerIdentity.of(authority, account.userId, account.organizationId);
  }

  private void retire() {
    if (release != null) release.close();
    release = null;
  }
}
