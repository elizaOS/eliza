package ai.eliza.plugins.securestore.nativeonly;

import java.io.IOException;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The password vault ciphertext frame: {@code 0x01 || 12-byte IV || AES-256-GCM ciphertext+tag},
 * authenticated with host-supplied AAD. Pure javax.crypto so the frame can be tested on a JVM
 * with a software key; on Android the key is a non-exportable Keystore key and the provider
 * generates the IV (randomized encryption is required by the key).
 */
public final class PasswordVaultFrame {
  private PasswordVaultFrame() {}
  public static final byte VERSION = 1;
  public static final int IV_BYTES = 12, TAG_BITS = 128, MAX_FRAME_BYTES = 4 * 1024 * 1024;
  /** Version byte, IV, at least one plaintext byte and the tag. */
  public static final int MIN_FRAME_BYTES = 1 + IV_BYTES + 1 + TAG_BITS / 8;

  public static byte[] seal(SecretKey key, byte[] aad, byte[] plaintext) throws Exception {
    if (key == null || aad == null || plaintext == null || plaintext.length == 0) throw new IOException("Invalid password storage input");
    if (plaintext.length > MAX_FRAME_BYTES - 64) throw new IOException("Password vault is full");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key);
    cipher.updateAAD(aad);
    byte[] iv = cipher.getIV();
    if (iv == null || iv.length != IV_BYTES) throw new IOException("Unexpected password storage IV");
    byte[] encrypted = cipher.doFinal(plaintext);
    byte[] frame = new byte[1 + IV_BYTES + encrypted.length];
    frame[0] = VERSION;
    System.arraycopy(iv, 0, frame, 1, IV_BYTES);
    System.arraycopy(encrypted, 0, frame, 1 + IV_BYTES, encrypted.length);
    Arrays.fill(encrypted, (byte) 0);
    return frame;
  }

  /** Throws on any version, length, AAD or tag mismatch. Never returns partial plaintext. */
  public static byte[] open(SecretKey key, byte[] aad, byte[] frame) throws Exception {
    if (key == null || aad == null || frame == null || frame.length < MIN_FRAME_BYTES || frame.length > MAX_FRAME_BYTES || frame[0] != VERSION)
      throw new IOException("Invalid password storage");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(frame, 1, 1 + IV_BYTES)));
    cipher.updateAAD(aad);
    return cipher.doFinal(frame, 1 + IV_BYTES, frame.length - 1 - IV_BYTES);
  }
}
