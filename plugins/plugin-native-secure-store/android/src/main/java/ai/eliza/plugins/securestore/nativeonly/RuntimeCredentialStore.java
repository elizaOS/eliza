package ai.eliza.plugins.securestore.nativeonly;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Cloud credential ciphertext persists; the non-exportable key belongs to Android Keystore. */
public class RuntimeCredentialStore {
  private final AtomicFile file;
  private final String alias;
  private final byte[] aad;
  private final boolean developmentMigration;
  public RuntimeCredentialStore(File root, String alias, String filename, byte[] aad, boolean developmentMigration) {
    if (!filename.matches("[A-Za-z0-9._-]+") || filename.equals(".") || filename.equals("..")) throw new IllegalArgumentException("Invalid credential filename");
    this.file = new AtomicFile(new File(root, filename)); this.alias = alias;
    this.aad = aad.clone(); this.developmentMigration = developmentMigration;
  }
  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
    if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256).setRandomizedEncryptionRequired(true).build());
    return generator.generateKey();
  }
  public synchronized String read() throws Exception {
    File base = file.getBaseFile(), backup = new File(base.getPath() + ".bak");
    if (!base.exists() && !backup.exists()) return null;
    // A committed AtomicFile backup survives a process death before base recovery.
    for (File candidate : new File[]{base, backup}) {
      if (java.nio.file.Files.isSymbolicLink(candidate.toPath()) || (candidate.exists() && (!candidate.isFile() || candidate.length() > 20000))) throw new IOException("Invalid encrypted account storage");
    }
    byte[] bytes = file.readFully();
    if (bytes.length < 30 || bytes[0] != 1) throw new IOException("Invalid encrypted account storage");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(bytes, 1, 13))); cipher.updateAAD(aad);
    String value = new String(cipher.doFinal(bytes, 13, bytes.length - 13), StandardCharsets.UTF_8);
    validate(value); return value;
  }
  public synchronized void write(String value) throws Exception {
    validate(value);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(aad);
    byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
    FileOutputStream out = null;
    try { out = file.startWrite(); out.write(1); out.write(cipher.getIV()); out.write(ciphertext); file.finishWrite(out); }
    catch (Exception failure) { if (out != null) file.failWrite(out); throw failure; }
    File target = file.getBaseFile(); target.setReadable(false, false); target.setReadable(true, true); target.setWritable(false, false); target.setWritable(true, true);
  }
  public synchronized void clear() { file.delete(); }
  public synchronized void migrateDevelopmentFile(File legacy) throws Exception {
    if (!legacy.exists()) return;
    if (!developmentMigration) throw new IOException("Plaintext account enrollment is unavailable in this build");
    if (!legacy.isFile() || legacy.length() > 16384 || java.nio.file.Files.isSymbolicLink(legacy.toPath())) throw new IOException("Invalid development account credential");
    String value = new String(java.nio.file.Files.readAllBytes(legacy.toPath()), StandardCharsets.UTF_8).trim();
    write(value);
    if (!legacy.delete()) throw new IOException("Cannot remove migrated development credential");
  }
  public static void scrubKnownConfigs(File runtimeRoot, String credential) throws Exception {
    if (credential == null) return;
    File accounts = new File(runtimeRoot, "state/accounts");
    File[] directories = accounts.listFiles(); if (directories == null) return;
    for (File directory : directories) {
      if (!directory.isDirectory() || java.nio.file.Files.isSymbolicLink(directory.toPath()) || !directory.getName().matches("local|cloud-[0-9a-f]{64}")) continue;
      for (String name : new String[]{"config.json", "launch-config.json", "eliza.config-overlay.json"}) {
        File config = new File(directory, name);
        if (!config.exists()) continue;
        if (java.nio.file.Files.isSymbolicLink(config.toPath()) || !config.isFile() || config.length() > 1024 * 1024) throw new IOException("Cannot safely migrate account configuration");
        org.json.JSONObject data = new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(config.toPath()), StandardCharsets.UTF_8));
        if (!removeMatchingCredential(data, credential)) continue;
        AtomicFile atomic = new AtomicFile(config); FileOutputStream out = null;
        try { out = atomic.startWrite(); out.write(data.toString(2).getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(out); }
        catch (Exception failure) { if (out != null) atomic.failWrite(out); throw failure; }
        config.setReadable(false, false); config.setReadable(true, true); config.setWritable(false, false); config.setWritable(true, true);
      }
    }
  }
  private static boolean removeMatchingCredential(Object node, String credential) throws Exception {
    boolean changed = false;
    if (node instanceof org.json.JSONObject) {
      org.json.JSONObject object = (org.json.JSONObject) node;
      java.util.ArrayList<String> names = new java.util.ArrayList<>(); object.keys().forEachRemaining(names::add);
      for (String name : names) { Object value = object.get(name); if (credential.equals(value)) { object.remove(name); changed = true; } else changed |= removeMatchingCredential(value, credential); }
    } else if (node instanceof org.json.JSONArray) {
      org.json.JSONArray array = (org.json.JSONArray) node;
      for (int i = 0; i < array.length(); i++) { Object value = array.get(i); if (credential.equals(value)) { array.put(i, org.json.JSONObject.NULL); changed = true; } else changed |= removeMatchingCredential(value, credential); }
    }
    return changed;
  }
  private static void validate(String value) throws IOException {
    if (value == null || value.length() < 20 || value.length() > 16384 || !value.equals(value.trim()) || value.contains("\r") || value.contains("\n")) throw new IOException("Invalid account credential");
  }
}
