package ai.eliza.plugins.messages.vvm;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The default {@link VvmSecrets}: each slot is one AES-256-GCM file under the app's
 * {@code noBackupFilesDir} (app-private, credential-encrypted, never backed up), sealed with a
 * non-exportable Android Keystore key and bound to its slot name. Clearing deletes the files;
 * clearing everything also deletes the key, so an undeleted copy could not be opened.
 */
public final class KeystoreVvmSecrets implements VvmSecrets {
 private static final String KEY_ALIAS = "ai.eliza.plugins.messages.vvm.account", DIRECTORY = "visual-voicemail";
 private static final int MAX_BYTES = 16 * 1024, IV_BYTES = 12;
 private final File directory;

 public KeystoreVvmSecrets(Context context) { directory = new File(context.getApplicationContext().getNoBackupFilesDir(), DIRECTORY); }

 private static String name(String slot) {
  if (slot == null || !slot.matches("[a-f0-9]{16,64}")) throw new IllegalArgumentException("Invalid voicemail slot");
  return slot;
 }
 private static SecretKey key(boolean create) throws Exception {
  KeyStore store = KeyStore.getInstance("AndroidKeyStore");
  store.load(null);
  java.security.Key key = store.getKey(KEY_ALIAS, null);
  if (key instanceof SecretKey) return (SecretKey) key;
  if (!create) return null;
  KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
  generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
  return generator.generateKey();
 }

 @Override public synchronized String read(String slot) throws Exception {
  File file = new File(directory, name(slot));
  if (!file.isFile()) return null;
  if (file.length() <= IV_BYTES || file.length() > MAX_BYTES) throw new IOException("Unreadable voicemail account");
  ByteArrayOutputStream bytes = new ByteArrayOutputStream();
  try (FileInputStream in = new FileInputStream(file)) {
   byte[] buffer = new byte[4096];
   for (int n; (n = in.read(buffer)) > 0; ) { if (bytes.size() + n > MAX_BYTES) throw new IOException("Unreadable voicemail account"); bytes.write(buffer, 0, n); }
  }
  byte[] sealed = bytes.toByteArray();
  SecretKey key = key(false);
  if (key == null) throw new IOException("Unreadable voicemail account");
  Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
  cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, sealed, 0, IV_BYTES));
  cipher.updateAAD(slot.getBytes(StandardCharsets.UTF_8));
  return new String(cipher.doFinal(sealed, IV_BYTES, sealed.length - IV_BYTES), StandardCharsets.UTF_8);
 }

 @Override public synchronized void write(String slot, String value) throws Exception {
  byte[] plain = value.getBytes(StandardCharsets.UTF_8);
  if (plain.length > MAX_BYTES - 64) throw new IllegalArgumentException("Voicemail account too large");
  Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
  cipher.init(Cipher.ENCRYPT_MODE, key(true));
  cipher.updateAAD(name(slot).getBytes(StandardCharsets.UTF_8));
  byte[] iv = cipher.getIV(), sealed = cipher.doFinal(plain);
  if (iv == null || iv.length != IV_BYTES) throw new IOException("Unexpected cipher");
  if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Voicemail account not stored");
  File pending = new File(directory, slot + ".tmp"), file = new File(directory, slot);
  try (FileOutputStream out = new FileOutputStream(pending)) { out.write(iv); out.write(sealed); out.getFD().sync(); }
  if (!pending.renameTo(file)) { pending.delete(); throw new IOException("Voicemail account not stored"); }
 }

 @Override public synchronized void clear(String slot) throws Exception {
  File file = new File(directory, name(slot));
  new File(directory, slot + ".tmp").delete();
  if (file.exists() && !file.delete()) throw new IOException("Voicemail account not cleared");
 }

 @Override public synchronized void clearAll() throws Exception {
  boolean left = false;
  File[] files = directory.listFiles();
  if (files != null) for (File file : files) left |= !file.delete();
  KeyStore store = KeyStore.getInstance("AndroidKeyStore");
  store.load(null);
  store.deleteEntry(KEY_ALIAS);
  if (left) throw new IOException("Voicemail accounts not cleared");
 }
}
