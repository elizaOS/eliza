package ai.eliza.host;

import ai.eliza.plugins.agent.runtime.LocalCredentialBroker;
import ai.eliza.plugins.agent.runtime.NativeRuntimeSession;
import ai.eliza.plugins.securestore.nativeonly.TaskDataKeyStore;
import ai.eliza.plugins.securestore.nativeonly.VerifiedAccountCredentialStore;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.Objects;
import org.json.JSONObject;

/** Optional trusted Android host composition. Never register as a renderer bridge. */
public final class VerifiedTaskCustody implements AutoCloseable {
  private final NativeRuntimeSession.Scope scope;
  private final VerifiedAccountCredentialStore accounts;
  private final TaskDataKeyStore keys;
  private final Path databaseRoot;
  private boolean closed;
  private final LocalCredentialBroker.Guard guard;

  /** Reuse the host's dedicated verified-account directory/alias; do not create a parallel owner record.
   * All native account writes must use this instance. DatabaseRoot is an existing private no-backup
   * directory. The actual Bun writer must hold its native lease before any task-key request.
   */
  public VerifiedTaskCustody(NativeRuntimeSession.Scope scope, File accountDirectory,
      String accountAlias, File keyDirectory, String keyAlias, File databaseRoot) throws Exception {
    this.scope = Objects.requireNonNull(scope);
    guard = () -> { if (closed) throw unavailable(); this.scope.check(); };
    this.databaseRoot = databaseRoot.toPath().toAbsolutePath().normalize();
    if (!this.databaseRoot.equals(this.databaseRoot.toRealPath())) throw unavailable();
    requireDirectory(this.databaseRoot);
    accounts = new VerifiedAccountCredentialStore(accountDirectory, accountAlias, guard);
    keys = new TaskDataKeyStore(keyDirectory, keyAlias);
    scope.check();
    scope.onClose(this::close);
  }

  /** Guard identity must be shared by both optional broker ports. */
  public LocalCredentialBroker.Guard guard() { return guard; }

  public LocalCredentialBroker.VerifiedAccountStore accountPort() {
    return new LocalCredentialBroker.VerifiedAccountStore() {
      public String read() throws Exception { return accounts.read(guard::check); }
      public boolean compareExchange(String expected, String next) throws Exception {
        return accounts.compareExchange(expected, next, guard::check);
      }
    };
  }

  /** Opens the existing private broker and closes it with this native launch. A null database
   * permits verified enrollment before a database is bound, with task-key access disabled. */
  public LocalCredentialBroker openBroker(LocalCredentialBroker.Store legacy,
      LocalCredentialBroker.Store pending, String token, Database database) throws Exception {
    synchronized (guard) {
      guard.check();
      if (database != null) {
        if (database.owner != this) throw unavailable();
        database.check();
      }
      LocalCredentialBroker broker = new LocalCredentialBroker(legacy, pending, token, database,
          database == null ? null : guard, accountPort(), guard);
      try {
        scope.onClose(broker::close);
        guard.check();
        return broker;
      } catch (Exception failure) { broker.close(); throw failure; }
    }
  }

  /** Native-selected logical database name, never a value received over the broker or renderer. */
  public Database bindDatabase(String name) throws Exception {
    synchronized (guard) {
      guard.check();
      if (name == null || !name.matches("[a-z0-9][a-z0-9._-]{0,63}")) throw unavailable();
      String snapshot = accounts.read(guard::check);
      if (snapshot == null) throw unavailable();
      String identity = ownerIdentity(snapshot);
      Path owner = databaseRoot.resolve(identity.substring("cloud-owner-v1:".length()));
      requireDirectory(databaseRoot);
      try { Files.createDirectory(owner); android.system.Os.chmod(owner.toString(), 0700); }
      catch (java.nio.file.FileAlreadyExistsException exists) { /* Inspect without following links. */ }
      requireDirectory(owner);
      Database result = new Database(snapshot, identity, name, owner.resolve(name + ".sqlite"));
      result.check();
      return result;
    }
  }

  public final class Database implements LocalCredentialBroker.TaskKeyCustody {
    private final VerifiedTaskCustody owner = VerifiedTaskCustody.this;
    public final String ownerIdentity;
    public final Path path;
    private final String snapshot;
    private final String name;
    private Database(String snapshot, String identity, String name, Path path) {
      this.snapshot = snapshot; this.ownerIdentity = identity; this.name = name; this.path = path;
    }
    /** Native lifecycle fence, also required when the host admits its writer process. */
    public void check() throws Exception {
      synchronized (guard) {
        guard.check();
        if (!snapshot.equals(accounts.read(guard::check))) throw unavailable();
        requireDirectory(databaseRoot);
        requireDirectory(path.getParent());
      }
    }
    public String read() throws Exception {
      synchronized (guard) {
        check();
        try (TaskDataKeyStore.Key key = keys.read(ownerIdentity, name)) {
          if (key == null && !absent()) throw unavailable();
          check();
          return encode(key);
        }
      }
    }
    public String createForNewDatabase() throws Exception {
      synchronized (guard) {
        check();
        if (!absent()) throw unavailable();
        try (TaskDataKeyStore.Key key = keys.createIfAbsent(ownerIdentity, name)) {
          check();
          if (!absent()) throw unavailable();
          return encode(key);
        }
      }
    }
    public boolean remove(String expectedKeyId) throws Exception {
      synchronized (guard) {
        check();
        if (!absent()) throw unavailable();
        boolean removed = keys.remove(ownerIdentity, name, expectedKeyId);
        check();
        return removed;
      }
    }
    private boolean absent() throws IOException {
      for (String suffix : new String[] {"", "-wal", "-shm", "-journal"}) {
        try {
          Files.readAttributes(Path.of(path.toString() + suffix), BasicFileAttributes.class,
              LinkOption.NOFOLLOW_LINKS);
          return false;
        } catch (NoSuchFileException absent) { /* Only a confirmed missing entry is new. */ }
      }
      return true;
    }
  }

  /** Match the existing gateway's SHA256(JSON.stringify([authority,userId,organizationId])). */
  public static String ownerIdentity(String snapshot) throws Exception {
    VerifiedAccountCredentialStore.validate(snapshot);
    if (snapshot == null) throw unavailable();
    JSONObject owner = new JSONObject(snapshot).getJSONObject("owner");
    String tuple = "[" + quote(owner.getString("authority")) + "," + quote(owner.getString("userId"))
        + "," + quote(owner.getString("organizationId")) + "]";
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(tuple.getBytes(StandardCharsets.UTF_8));
    StringBuilder hex = new StringBuilder("cloud-owner-v1:");
    for (byte b : hash) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
    return hex.toString();
  }
  // Validated strings contain no control characters or unpaired surrogates. Android JSON may
  // escape '/', unlike JavaScript JSON.stringify; explicitly preserve the established bytes.
  private static String quote(String value) { return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
  private static String encode(TaskDataKeyStore.Key key) throws Exception {
    if (key == null) return null;
    byte[] bytes = key.copyBytes();
    try {
      return new JSONObject().put("version", 1).put("id", key.id)
          .put("key", Base64.getEncoder().encodeToString(bytes)).toString();
    } finally { Arrays.fill(bytes, (byte) 0); }
  }
  private static void requireDirectory(Path path) throws Exception {
    if (!Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS).isDirectory()
        || !path.equals(path.toRealPath())) throw unavailable();
    android.system.StructStat stat = android.system.Os.lstat(path.toString());
    if (stat.st_uid != android.system.Os.getuid() || (stat.st_mode & 0077) != 0) throw unavailable();
  }
  private static IOException unavailable() { return new IOException("Native task custody unavailable"); }
  @Override public void close() { synchronized (guard) { closed = true; } }
}
