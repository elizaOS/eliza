package ai.eliza.plugins.securestore.nativeonly;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Native-only codec for deployed Base64(IV):Base64(AES-GCM ciphertext/tag) records.
 * No AAD or user-authentication requirement: hosts retain their existing alias,
 * storage location and access policy. Do not use this as a password-vault grant.
 * All instances serialize cold key creation within this process.
 */
public final class KeystoreTextFrame {
  private static final Object KEYS = new Object();
  private final String alias;
  private final int maxEncodedChars;

  public KeystoreTextFrame(String alias, int maxEncodedChars) {
    if (alias == null || alias.isEmpty() || maxEncodedChars < 41) throw new IllegalArgumentException();
    this.alias = alias; this.maxEncodedChars = maxEncodedChars;
  }

  private SecretKey key() throws Exception {
    synchronized (KEYS) {
      KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
      if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
      generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
      return generator.generateKey();
    }
  }

  public String seal(String value) throws Exception {
    if (value == null || value.length() > maxEncodedChars) throw new IllegalArgumentException("Text frame exceeds limit");
    byte[] plain = value.getBytes(StandardCharsets.UTF_8);
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
      String packed = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
        + Base64.encodeToString(cipher.doFinal(plain), Base64.NO_WRAP);
      if (packed.length() > maxEncodedChars) throw new IllegalArgumentException("Text frame exceeds limit");
      return packed;
    } finally { Arrays.fill(plain, (byte) 0); }
  }

  public String open(String packed) throws Exception {
    if (packed == null || packed.length() > maxEncodedChars) throw new IllegalArgumentException("Invalid text frame");
    int split = packed.indexOf(':');
    if (split < 1 || split != packed.lastIndexOf(':')) throw new IllegalArgumentException("Invalid text frame");
    byte[] iv = Base64.decode(packed.substring(0, split), Base64.NO_WRAP);
    byte[] encrypted = Base64.decode(packed.substring(split + 1), Base64.NO_WRAP);
    if (iv.length != 12 || encrypted.length < 16) throw new IllegalArgumentException("Invalid text frame");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
    byte[] plain = cipher.doFinal(encrypted);
    try { return new String(plain, StandardCharsets.UTF_8); }
    finally { Arrays.fill(plain, (byte) 0); }
  }
}
