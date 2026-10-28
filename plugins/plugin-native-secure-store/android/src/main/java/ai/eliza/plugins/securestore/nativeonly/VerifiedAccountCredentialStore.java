package ai.eliza.plugins.securestore.nativeonly;

import java.io.File;
import java.net.URI;
import java.util.Objects;
import org.json.JSONObject;

/** Optional native-only atomic credential/verified-owner record. No legacy slot migration or bridge. */
public final class VerifiedAccountCredentialStore {
  private static final String SLOT = "verified-account-credential:v1";
  private final JsonCredentialSlots slots;
  private final Object ownerLock;
  @FunctionalInterface public interface Guard { void check() throws Exception; }

  /** Use a dedicated directory/alias. All owner changes must serialize on ownerLock. */
  public VerifiedAccountCredentialStore(File directory, String alias, Object ownerLock) {
    this.slots = new JsonCredentialSlots(directory, alias, slot -> 8192);
    this.ownerLock = Objects.requireNonNull(ownerLock);
  }

  /** Exact opaque snapshot for a later compareExchange; may contain credentials, never log it. */
  public String read(Guard guard) throws Exception {
    Objects.requireNonNull(guard);
    synchronized (ownerLock) {
     synchronized (JsonCredentialSlots.LOCK) {
      guard.check();
      String value = slots.read(SLOT);
      validate(value);
      guard.check();
      return value;
     }
    }
  }

  /** Atomically replace or clear the whole record; false means the snapshot was superseded. */
  public boolean compareExchange(String expected, String next, Guard guard) throws Exception {
    Objects.requireNonNull(guard);
    validate(expected);
    validate(next);
    synchronized (ownerLock) {
     synchronized (JsonCredentialSlots.LOCK) {
      guard.check();
      boolean committed = slots.compareExchange(SLOT, expected, next);
      guard.check();
      return committed;
     }
    }
  }

  /** Input must come from authenticated host verification, not a renderer or decoded JWT claims. */
  public static void validate(String value) throws Exception {
    if (value == null) return;
    JSONObject record = new JSONObject(value);
    if (record.length() != 4 || !(record.opt("version") instanceof Integer)
        || record.getInt("version") != 1) invalid();
    required(record, "credential", 20, 512);
    required(record, "credentialId", 1, 256);
    Object candidate = record.opt("owner");
    if (!(candidate instanceof JSONObject)) invalid();
    JSONObject owner = (JSONObject) candidate;
    if (owner.length() != 3) invalid();
    required(owner, "userId", 1, 256);
    required(owner, "organizationId", 1, 256);
    URI authority = new URI(required(owner, "authority", 1, 2048));
    String host = authority.getHost();
    boolean local = "localhost".equals(host) || "127.0.0.1".equals(host) || "[::1]".equals(host);
    if (host == null || authority.getRawUserInfo() != null || authority.getRawQuery() != null
        || authority.getRawFragment() != null || !authority.getRawPath().isEmpty()
        || !("https".equals(authority.getScheme()) || (local && "http".equals(authority.getScheme())))) invalid();
  }

  private static String required(JSONObject object, String key, int min, int max) throws Exception {
    Object candidate = object.opt(key);
    if (!(candidate instanceof String)) { invalid(); return null; }
    String value = (String) candidate;
    if (value.length() < min || value.length() > max || !value.equals(value.trim())) invalid();
    for (int i=0;i<value.length();i++) {
      char c=value.charAt(i);
      if (Character.isISOControl(c)) invalid();
      if (Character.isHighSurrogate(c)) {
        if (++i>=value.length() || !Character.isLowSurrogate(value.charAt(i))) invalid();
      } else if (Character.isLowSurrogate(c)) invalid();
    }
    return value;
  }
  private static void invalid() { throw new IllegalArgumentException("Invalid verified account record"); }
}
