package ai.eliza.plugins.securestore.nativeonly;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import org.json.JSONObject;

/** Native-host-only data keys. This class does not encrypt or open a database. */
public final class TaskDataKeyStore {
  private final JsonCredentialSlots slots;
  private final SecureRandom random = new SecureRandom();

  /** Supply a dedicated no-backup directory and Keystore alias, never credential/password identities. */
  public TaskDataKeyStore(File directory, String alias) {
    slots = new JsonCredentialSlots(directory, alias, slot -> 512);
  }

  /** Returns null without creating a missing key. The host must refuse an existing database in that case. */
  public Key read(String accountId, String databaseId) throws Exception {
    synchronized (JsonCredentialSlots.LOCK) {
      return decode(slots.read(slot(accountId, databaseId)));
    }
  }

  /** Only call for a new database or a new migration destination, under the host's writer lease. */
  public Key createIfAbsent(String accountId, String databaseId) throws Exception {
    String slot = slot(accountId, databaseId);
    synchronized (JsonCredentialSlots.LOCK) {
      String existing = slots.read(slot);
      if (existing != null) return decode(existing);
      byte[] bytes = new byte[32];
      random.nextBytes(bytes);
      try {
        String value = new JSONObject().put("version", 1)
            .put("id", UUID.randomUUID().toString())
            .put("key", Base64.getEncoder().encodeToString(bytes)).toString();
        slots.write(slot, value);
        // Never acknowledge a key before durable storage and authenticated read-back succeed.
        String committed = slots.read(slot);
        if (!value.equals(committed)) throw new IllegalStateException("Task key storage unavailable");
        return decode(committed);
      } finally {
        Arrays.fill(bytes, (byte) 0);
      }
    }
  }

  /** Compare the key generation so delayed account cleanup cannot erase a replacement key. */
  public boolean remove(String accountId, String databaseId, String expectedKeyId) throws Exception {
    if (!validId(expectedKeyId)) throw new IllegalArgumentException("Invalid task key generation");
    synchronized (JsonCredentialSlots.LOCK) {
      String slot = slot(accountId, databaseId);
      String current = slots.read(slot);
      if (current == null) return false;
      try (Key key = decode(current)) {
        if (!key.id.equals(expectedKeyId)) return false;
        return slots.compareExchange(slot, current, null);
      }
    }
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
    return "task-data-key:v1:" + Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest());
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
