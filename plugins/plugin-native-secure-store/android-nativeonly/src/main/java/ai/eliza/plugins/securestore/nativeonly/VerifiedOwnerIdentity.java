package ai.eliza.plugins.securestore.nativeonly;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * The owner digest of the gateway's {@code verifiedOwnerIdentity}: {@code cloud-owner-v1:} and the
 * SHA-256 of the JSON text {@code [authority,userId,organizationId]}. Plain Java, so a JVM test
 * holds it to the JavaScript bytes. Callers pass validated owner strings only (no control
 * characters or unpaired surrogates); see {@link VerifiedAccountCredentialStore#ownerIdentity}.
 */
final class VerifiedOwnerIdentity {
  static final String PREFIX = "cloud-owner-v1:";

  private VerifiedOwnerIdentity() {}

  static String of(String authority, String userId, String organizationId) throws Exception {
    String tuple = "[" + quote(authority) + "," + quote(userId) + "," + quote(organizationId) + "]";
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(tuple.getBytes(StandardCharsets.UTF_8));
    StringBuilder hex = new StringBuilder(PREFIX);
    for (byte b : hash) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
    return hex.toString();
  }

  // JSON.stringify escapes only backslash and quote in validated strings. Android's JSONObject also
  // escapes '/', so the tuple is written here to keep the gateway's exact bytes.
  private static String quote(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }
}
