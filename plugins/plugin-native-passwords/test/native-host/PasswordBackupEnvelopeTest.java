package ai.eliza.plugins.securestore.nativeonly;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class PasswordBackupEnvelopeTest {
  public static void main(String[] args) throws Exception {
    byte[] password = "synthetic saved password".getBytes(StandardCharsets.UTF_8);
    byte[] key = PasswordBackupEnvelope.newKey();
    String scope = "f".repeat(64);
    byte[] first = PasswordBackupEnvelope.seal(scope, key, password);
    byte[] second = PasswordBackupEnvelope.seal(scope, key, password);
    if (!Arrays.equals(password, PasswordBackupEnvelope.open(scope, key, first)))
      throw new AssertionError("Recovery key must restore the original data");
    if (Arrays.equals(first, second)) throw new AssertionError("Repeated saves must use a fresh IV");
    refuse(() -> PasswordBackupEnvelope.open(scope, PasswordBackupEnvelope.newKey(), first));
    refuse(() -> PasswordBackupEnvelope.open("e".repeat(64), key, first));
    first[first.length - 1] ^= 1;
    refuse(() -> PasswordBackupEnvelope.open(scope, key, first));
    refuse(() -> PasswordBackupEnvelope.seal(scope, key, new byte[PasswordBackupEnvelope.MAX_BYTES]));
    System.out.println("6 assertions passed");
  }

  private interface Attempt { void run() throws Exception; }
  private static void refuse(Attempt attempt) throws Exception {
    try {
      attempt.run();
    } catch (Exception refused) {
      return;
    }
    throw new AssertionError("Invalid backup input must be refused");
  }
}
