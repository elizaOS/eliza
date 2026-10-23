package ai.eliza.plugins.securestore.nativeonly;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import javax.crypto.KeyGenerator;
import org.json.JSONObject;

/** Native-host-only data keys. This class does not encrypt or open a database. */
public final class TaskDataKeyStore {
  private static final String SLOT_PREFIX = "task-data-key:v1:";
  private final File directory;
  private final JsonCredentialSlots shared;
  private final String aliasPrefix;
  private final boolean preferStrongBox;
  private final SecureRandom random = new SecureRandom();

  /** The slot's wrapped copy exists but its per-slot Keystore key is gone: the key is erased. */
  public static final class WrappingKeyMissingException extends IllegalStateException {
    private static final long serialVersionUID = 1L;
    WrappingKeyMissingException() { super("Task key wrapping key is missing"); }
  }

  /** A host step that runs while both slots hold the adopted key. */
  public interface AdoptStep { void run() throws Exception; }

  /** Supply a dedicated no-backup directory and Keystore alias, never credential/password identities. */
  public TaskDataKeyStore(File directory, String alias) {
    this.directory = directory;
    shared = new JsonCredentialSlots(directory, alias, slot -> 512);
    aliasPrefix = null;
    preferStrongBox = false;
  }

  private TaskDataKeyStore(File directory, String aliasPrefix, boolean preferStrongBox) {
    if (aliasPrefix == null || aliasPrefix.isEmpty() || aliasPrefix.length() > 512)
      throw new IllegalArgumentException("Invalid task key alias prefix");
    this.directory = java.util.Objects.requireNonNull(directory);
    shared = null;
    this.aliasPrefix = aliasPrefix;
    this.preferStrongBox = preferStrongBox;
  }

  /**
   * Each slot gets its own Keystore wrapping key, {@code aliasPrefix} plus the slot digest, so
   * {@link #destroy} and {@link #remove} erase one key by deleting its Keystore entry. With
   * {@code preferStrongBox}, new wrapping keys are created in StrongBox when the device has one,
   * else in the default Keystore. Reserve a new directory and alias prefix for this mode.
   */
  public static TaskDataKeyStore perSlot(File directory, String aliasPrefix, boolean preferStrongBox) {
    return new TaskDataKeyStore(directory, aliasPrefix, preferStrongBox);
  }

  /** Returns null without creating a missing key. The host must refuse an existing database in that case. */
  public Key read(String accountId, String databaseId) throws Exception {
    synchronized (JsonCredentialSlots.LOCK) {
      return decode(readSlot(slot(accountId, databaseId)));
    }
  }

  /** Only call for a new database or a new migration destination, under the host's writer lease. */
  public Key createIfAbsent(String accountId, String databaseId) throws Exception {
    String slot = slot(accountId, databaseId);
    synchronized (JsonCredentialSlots.LOCK) {
      String existing = readSlot(slot);
      if (existing != null) return decode(existing);
      byte[] bytes = new byte[32];
      random.nextBytes(bytes);
      try { return store(slot, UUID.randomUUID().toString(), bytes); }
      finally { Arrays.fill(bytes, (byte) 0); }
    }
  }

  /** Compare the key generation so delayed account cleanup cannot erase a replacement key. */
  public boolean remove(String accountId, String databaseId, String expectedKeyId) throws Exception {
    if (!validId(expectedKeyId)) throw new IllegalArgumentException("Invalid task key generation");
    synchronized (JsonCredentialSlots.LOCK) {
      String slot = slot(accountId, databaseId);
      String current = readSlot(slot);
      if (current == null) return false;
      try (Key key = decode(current)) {
        if (!key.id.equals(expectedKeyId)) return false;
        if (shared != null) return shared.compareExchange(slot, current, null);
        erase(slot);
        return true;
      }
    }
  }

  /**
   * Per-slot mode only. Crypto-erases the slot: deletes its Keystore entry first, then its wrapped
   * copy, so data encrypted under the key cannot be decrypted even if the file's bytes survive.
   * Also completes an interrupted destroy. True when either existed.
   */
  public boolean destroy(String accountId, String databaseId) throws Exception {
    if (shared != null) throw new IllegalStateException("Destroy requires per-slot wrapping keys");
    synchronized (JsonCredentialSlots.LOCK) {
      String slot = slot(accountId, databaseId);
      boolean existed = keyStore().containsAlias(wrappingAlias(slot)) || stored(slot);
      erase(slot);
      return existed;
    }
  }

  /**
   * Moves the database's key from one account to another with the same generation and bytes.
   * The target is written and read back first; then {@code step} (may be null) runs, for example
   * to move the host's files; only then is the source erased. A repeat after a crash resumes.
   * Returns false, changing nothing, when the source has no key or the target already holds a
   * different key.
   */
  public boolean adopt(String fromAccountId, String toAccountId, String databaseId, AdoptStep step)
      throws Exception {
    String from = slot(fromAccountId, databaseId), to = slot(toAccountId, databaseId);
    if (from.equals(to)) throw new IllegalArgumentException("Task key adoption needs two accounts");
    synchronized (JsonCredentialSlots.LOCK) {
      try (Key source = decode(readSlot(from))) {
        if (source == null) return false;
        byte[] bytes = source.copyBytes();
        try (Key target = decode(readSlot(to))) {
          if (target == null) store(to, source.id, bytes).close();
          else {
            byte[] held = target.copyBytes();
            try { if (!target.id.equals(source.id) || !MessageDigest.isEqual(held, bytes)) return false; }
            finally { Arrays.fill(held, (byte) 0); }
          }
        } finally { Arrays.fill(bytes, (byte) 0); }
        if (step != null) step.run();
        erase(from);
        return true;
      }
    }
  }

  private String readSlot(String slot) throws Exception {
    if (shared != null) return shared.read(slot);
    // Never let a read create a wrapping key: a lost key stays visible as erased custody.
    if (!keyStore().containsAlias(wrappingAlias(slot))) {
      if (stored(slot)) throw new WrappingKeyMissingException();
      return null;
    }
    return slots(slot).read(slot);
  }

  /** Never acknowledge a key before durable storage and authenticated read-back succeed. */
  private Key store(String slot, String id, byte[] bytes) throws Exception {
    String value = new JSONObject().put("version", 1).put("id", id)
        .put("key", Base64.getEncoder().encodeToString(bytes)).toString();
    if (shared == null) createWrappingKey(wrappingAlias(slot));
    JsonCredentialSlots target = slots(slot);
    target.write(slot, value);
    String committed = target.read(slot);
    if (!value.equals(committed)) throw new IllegalStateException("Task key storage unavailable");
    return decode(committed);
  }

  private void erase(String slot) throws Exception {
    if (shared != null) { shared.remove(slot); return; }
    KeyStore keys = keyStore();
    String alias = wrappingAlias(slot);
    if (keys.containsAlias(alias)) keys.deleteEntry(alias);
    if (keys.containsAlias(alias)) throw new IllegalStateException("Task key could not be destroyed");
    slots(slot).remove(slot);
  }

  private JsonCredentialSlots slots(String slot) {
    return shared != null ? shared : new JsonCredentialSlots(directory, wrappingAlias(slot), ignored -> 512);
  }

  private boolean stored(String slot) throws Exception {
    JsonCredentialSlots slots = slots(slot);
    File file = slots.slotFile(slots.slotHash(slot)).getBaseFile();
    return file.exists() || new File(file.getPath() + ".bak").exists();
  }

  private String wrappingAlias(String slot) { return aliasPrefix + slot.substring(SLOT_PREFIX.length()); }

  /** An entry left by an interrupted create or destroy is never reused. */
  private void createWrappingKey(String alias) throws Exception {
    KeyStore keys = keyStore();
    if (keys.containsAlias(alias)) keys.deleteEntry(alias);
    if (preferStrongBox && Build.VERSION.SDK_INT >= 28) {
      try { generate(alias, true); return; }
      catch (StrongBoxUnavailableException unavailable) { /* Use the default Keystore below. */ }
    }
    generate(alias, false);
  }

  private static void generate(String alias, boolean strongBox) throws Exception {
    KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256);
    if (strongBox) spec.setIsStrongBoxBacked(true);
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(spec.build());
    generator.generateKey();
  }

  private static KeyStore keyStore() throws Exception {
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
    keys.load(null);
    return keys;
  }

  static String slot(String accountId, String databaseId) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    for (String value : new String[] {accountId, databaseId}) {
      if (value == null || value.isEmpty() || value.length() > 2048)
        throw new IllegalArgumentException("Invalid task storage identity");
      // Reject malformed Unicode rather than letting UTF-8 replacement collide with another owner.
      ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder()
          .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
          .encode(CharBuffer.wrap(value));
      digest.update(ByteBuffer.allocate(4).putInt(encoded.remaining()).array());
      digest.update(encoded);
    }
    return SLOT_PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest());
  }

  private static boolean validId(String value) {
    if (value == null) return false;
    try { return UUID.fromString(value).toString().equals(value); }
    catch (IllegalArgumentException e) { return false; }
  }

  private static Key decode(String value) throws Exception {
    if (value == null) return null;
    JSONObject object = new JSONObject(value);
    if (object.length() != 3 || !(object.opt("version") instanceof Integer)
        || object.getInt("version") != 1 || !(object.opt("id") instanceof String)
        || !validId(object.getString("id")) || !(object.opt("key") instanceof String))
      throw new IllegalStateException("Invalid task key record");
    String encoded = object.getString("key");
    byte[] bytes = Base64.getDecoder().decode(encoded);
    if (bytes.length != 32 || !Base64.getEncoder().encodeToString(bytes).equals(encoded)) {
      Arrays.fill(bytes, (byte) 0);
      throw new IllegalStateException("Invalid task key record");
    }
    return new Key(object.getString("id"), bytes);
  }

  /** Short-lived native-process material; never log, persist plaintext, or send to a renderer/model. */
  public static final class Key implements AutoCloseable {
    public final String id;
    private byte[] bytes;
    private Key(String id, byte[] bytes) { this.id = id; this.bytes = bytes; }
    public synchronized byte[] copyBytes() {
      if (bytes == null) throw new IllegalStateException("Task key is closed");
      return bytes.clone();
    }
    @Override public synchronized void close() {
      if (bytes != null) Arrays.fill(bytes, (byte) 0);
      bytes = null;
    }
  }
}
