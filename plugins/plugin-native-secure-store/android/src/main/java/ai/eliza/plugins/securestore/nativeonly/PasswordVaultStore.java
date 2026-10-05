package ai.eliza.plugins.securestore.nativeonly;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/** Native-only password custody. No methods on this class are exposed through Capacitor. */
public class PasswordVaultStore {
  private final AtomicFile file;
  private final String alias;
  private final boolean authenticationRequired;
  private final byte[] aad;
  public PasswordVaultStore(File directory, String alias, byte[] aad, boolean authenticationRequired) throws IOException {
    this.aad = aad.clone();
    if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Password storage unavailable");
    this.file = new AtomicFile(new File(directory, "vault.enc")); this.alias = alias; this.authenticationRequired = authenticationRequired;
  }
  private SecretKey key(boolean existing) throws Exception {
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    if (keys.containsAlias(alias)) {
      SecretKey key=(SecretKey)keys.getKey(alias,null);
      android.security.keystore.KeyInfo info=(android.security.keystore.KeyInfo)SecretKeyFactory.getInstance(key.getAlgorithm(),"AndroidKeyStore").getKeySpec(key,android.security.keystore.KeyInfo.class);
      if (authenticationRequired && (!info.isUserAuthenticationRequired() || info.getUserAuthenticationValidityDurationSeconds()!=120)) throw new IOException("Password key authentication policy mismatch");
      if (authenticationRequired && android.os.Build.VERSION.SDK_INT>=30 && info.getUserAuthenticationType()!=KeyProperties.AUTH_DEVICE_CREDENTIAL) throw new IOException("Password key authenticator policy mismatch");
      return key;
    }
    if (existing) throw new IOException("Password encryption key unavailable");
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true);
    if (authenticationRequired) {
      spec.setUserAuthenticationRequired(true);
      if (android.os.Build.VERSION.SDK_INT>=30) spec.setUserAuthenticationParameters(120,KeyProperties.AUTH_DEVICE_CREDENTIAL);
      else spec.setUserAuthenticationValidityDurationSeconds(120);
    }
    if (android.os.Build.VERSION.SDK_INT >= 28) spec.setUnlockedDeviceRequired(true);
    generator.init(spec.build()); return generator.generateKey();
  }
  public android.security.keystore.KeyInfo keyProtection() throws Exception {
    SecretKey key=key(false);
    return (android.security.keystore.KeyInfo)SecretKeyFactory.getInstance(key.getAlgorithm(),"AndroidKeyStore").getKeySpec(key,android.security.keystore.KeyInfo.class);
  }
  private JSONArray load() throws Exception {
    File base=file.getBaseFile(), backup=new File(base.getPath()+".bak");
    if (!base.exists() && !backup.exists()) return new JSONArray();
    // AtomicFile must recover a committed legacy backup before a missing base
    // can be treated as an empty vault. Never overwrite recoverable records.
    for (File candidate : new File[]{base,backup}) {
      if (java.nio.file.Files.isSymbolicLink(candidate.toPath()) || (candidate.exists() && (!candidate.isFile() || candidate.length()>4*1024*1024))) throw new IOException("Invalid password storage");
    }
    byte[] bytes = file.readFully(); if (bytes.length < 30 || bytes[0] != 1) throw new IOException("Invalid password storage");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(true), new GCMParameterSpec(128, Arrays.copyOfRange(bytes, 1, 13))); cipher.updateAAD(aad);
    return new JSONArray(new String(cipher.doFinal(bytes, 13, bytes.length - 13), StandardCharsets.UTF_8));
  }
  private void persist(JSONArray records) throws Exception {
    byte[] plaintext = records.toString().getBytes(StandardCharsets.UTF_8);
    if (plaintext.length > 4 * 1024 * 1024 - 64) throw new IOException("Password vault is full");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(file.getBaseFile().exists())); cipher.updateAAD(aad);
    byte[] encrypted = cipher.doFinal(plaintext); Arrays.fill(plaintext, (byte)0);
    FileOutputStream out = null;
    try { out = file.startWrite(); out.write(1); out.write(cipher.getIV()); out.write(encrypted); file.finishWrite(out); }
    catch (Exception failure) { if (out != null) file.failWrite(out); throw failure; }
    File target = file.getBaseFile(); target.setReadable(false, false); target.setReadable(true, true); target.setWritable(false, false); target.setWritable(true, true);
  }
  public static String origin(String input) throws Exception {
    URI uri = new URI(input.trim());
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || uri.getRawPath().equals("/")) || uri.getPort() < -1 || uri.getPort() > 65535) throw new IOException("Use an HTTPS website address without a path");
    return new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT), uri.getPort() == 443 ? -1 : uri.getPort(), null, null, null).toASCIIString();
  }
  public synchronized JSONArray list() throws Exception {
    JSONArray records = load(), summaries = new JSONArray();
    for (int i = 0; i < records.length(); i++) { JSONObject item = records.getJSONObject(i); summaries.put(new JSONObject().put("id",item.getString("id")).put("origin",item.getString("origin")).put("username",item.getString("username"))); }
    return summaries;
  }
  public synchronized JSONObject get(String id) throws Exception {
    JSONArray records=load(); for(int i=0;i<records.length();i++) if(records.getJSONObject(i).getString("id").equals(id)) return records.getJSONObject(i); throw new IOException("Password no longer exists");
  }
  public synchronized String save(String id, String website, String username, String password) throws Exception {
    String normalized=origin(website);
    if(username == null || username.isEmpty() || username.length()>1024 || password == null || password.isEmpty() || password.length()>16384) throw new IOException("Enter a username and password");
    JSONArray records=load(); int found=-1;
    if(id != null) for(int i=0;i<records.length();i++) if(records.getJSONObject(i).getString("id").equals(id)) found=i;
    if(id != null && found<0) throw new IOException("Password no longer exists");
    if(id == null) { if(records.length()>=1000) throw new IOException("Password vault is full"); id=UUID.randomUUID().toString(); }
    JSONObject value=new JSONObject().put("id",id).put("origin",normalized).put("username",username).put("password",password).put("updatedAt",System.currentTimeMillis());
    if(found>=0) records.put(found,value); else records.put(value); persist(records); return id;
  }
  public synchronized void delete(String id) throws Exception {
    JSONArray records=load(); for(int i=records.length()-1;i>=0;i--) if(records.getJSONObject(i).getString("id").equals(id)) records.remove(i); persist(records);
  }
}
