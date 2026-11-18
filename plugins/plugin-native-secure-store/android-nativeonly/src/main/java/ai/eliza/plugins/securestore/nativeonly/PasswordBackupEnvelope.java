package ai.eliza.plugins.securestore.nativeonly;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import javax.crypto.spec.SecretKeySpec;

final class PasswordBackupEnvelope {
  static final int KEY_BYTES = 32;
  static final int MAX_BYTES = 2 * 1024 * 1024;
  private static final int FRAME_OVERHEAD = 1 + PasswordVaultFrame.IV_BYTES + PasswordVaultFrame.TAG_BITS / 8;

  private PasswordBackupEnvelope() {}

  static byte[] newKey() {
    byte[] key = new byte[KEY_BYTES];
    new SecureRandom().nextBytes(key);
    return key;
  }

  static byte[] seal(String scope, byte[] key, byte[] snapshot) throws Exception {
    if (snapshot.length > MAX_BYTES - FRAME_OVERHEAD) throw new IOException("Password backup is too large");
    return PasswordVaultFrame.seal(key(key), aad(scope), snapshot);
  }

  static byte[] open(String scope, byte[] key, byte[] envelope) throws Exception {
    if (envelope.length > MAX_BYTES) throw new IOException("Password backup is too large");
    return PasswordVaultFrame.open(key(key), aad(scope), envelope);
  }

  private static SecretKeySpec key(byte[] bytes) throws IOException {
    if (bytes == null || bytes.length != KEY_BYTES) throw new IOException("Invalid password recovery key");
    return new SecretKeySpec(bytes, "AES");
  }

  private static byte[] aad(String scope) throws IOException {
    if (scope == null || !scope.matches("[0-9a-f]{64}")) throw new IOException("Invalid password backup account");
    return ("eliza-password-backup:v1:" + scope).getBytes(StandardCharsets.US_ASCII);
  }
}
