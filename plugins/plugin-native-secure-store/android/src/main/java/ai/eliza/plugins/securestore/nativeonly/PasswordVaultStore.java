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
import org.json.*;

/** Native-only password custody. No methods on this class are exposed through Capacitor. */
public class PasswordVaultStore {
  /**
   * Keystore user-authentication policy for the vault key. {@link #LEGACY} is the policy of the
   * original boolean constructor (device credential, 120 seconds) and must be kept for deployed
   * aliases. New hosts choose a shorter window and may also accept strong biometrics. Changing the
   * policy of an existing alias is refused rather than silently weakening or re-keying it.
   */
  public static final class KeyPolicy {
    public static final KeyPolicy LEGACY = new KeyPolicy(120, false);
    public final int validitySeconds;
    public final boolean biometric;
    public KeyPolicy(int validitySeconds, boolean biometric) {
      if (validitySeconds < 5 || validitySeconds > 600) throw new IllegalArgumentException("Unsupported password unlock window");
      this.validitySeconds = validitySeconds; this.biometric = biometric;
    }
    int authenticators() { return biometric ? KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL : KeyProperties.AUTH_DEVICE_CREDENTIAL; }
  }
  public static final int MAX_ENTRIES = 1000, MAX_BINDINGS = 20, MAX_LABEL = 200, MAX_USERNAME = 1024, MAX_PASSWORD = 16384;
  private final AtomicFile file;
  private final String alias;
  private final boolean authenticationRequired;
  private final KeyPolicy policy;
  private final byte[] aad;
  public PasswordVaultStore(File directory, String alias, byte[] aad, boolean authenticationRequired) throws IOException {
    this(directory, alias, aad, authenticationRequired ? KeyPolicy.LEGACY : null);
  }
  /** A null policy creates an unauthenticated key: only for host-restricted synthetic tests. */
  public PasswordVaultStore(File directory, String alias, byte[] aad, KeyPolicy policy) throws IOException {
    this.aad = aad.clone();
    if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Password storage unavailable");
    this.file = new AtomicFile(new File(directory, "vault.enc")); this.alias = alias; this.policy = policy; this.authenticationRequired = policy != null;
  }
  private SecretKey key(boolean existing) throws Exception {
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    if (keys.containsAlias(alias)) {
      SecretKey key=(SecretKey)keys.getKey(alias,null);
      android.security.keystore.KeyInfo info=(android.security.keystore.KeyInfo)SecretKeyFactory.getInstance(key.getAlgorithm(),"AndroidKeyStore").getKeySpec(key,android.security.keystore.KeyInfo.class);
      if (authenticationRequired && (!info.isUserAuthenticationRequired() || info.getUserAuthenticationValidityDurationSeconds()!=policy.validitySeconds)) throw new IOException("Password key authentication policy mismatch");
      if (authenticationRequired && android.os.Build.VERSION.SDK_INT>=30 && info.getUserAuthenticationType()!=policy.authenticators()) throw new IOException("Password key authenticator policy mismatch");
      return key;
    }
    if (existing) throw new KeyLost();
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true);
    if (authenticationRequired) {
      spec.setUserAuthenticationRequired(true);
      if (android.os.Build.VERSION.SDK_INT>=30) spec.setUserAuthenticationParameters(policy.validitySeconds,policy.authenticators());
      else spec.setUserAuthenticationValidityDurationSeconds(policy.validitySeconds);
    }
    if (android.os.Build.VERSION.SDK_INT >= 28) spec.setUnlockedDeviceRequired(true);
    generator.init(spec.build()); return generator.generateKey();
  }
  /**
   * Stored records exist but their key is gone (for example, deleted with the screen lock). The
   * message is the historical one, so existing callers that match it keep working.
   */
  public static final class KeyLost extends IOException { KeyLost() { super("Password encryption key unavailable"); } }

  /**
   * True only when stored records exist and can never be decrypted on this device: the key is
   * missing or permanently invalidated. A key that merely needs user authentication is not.
   */
  public synchronized boolean unrecoverable() throws Exception {
    File base = file.getBaseFile(), backup = new File(base.getPath() + ".bak");
    if (!base.exists() && !backup.exists()) return false;
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    if (!keys.containsAlias(alias)) return true;
    SecretKey key = (SecretKey) keys.getKey(alias, null);
    if (key == null) return true;
    try { Cipher.getInstance("AES/GCM/NoPadding").init(Cipher.ENCRYPT_MODE, key); return false; }
    catch (android.security.keystore.KeyPermanentlyInvalidatedException invalidated) { return true; }
    catch (android.security.keystore.UserNotAuthenticatedException locked) { return false; }
  }

  /**
   * Deletes an {@link #unrecoverable()} vault and its key so that a new vault can be created.
   * Refuses while the records are still decryptable, so it can never destroy readable data.
   */
  public synchronized void resetUnrecoverable() throws Exception {
    if (!unrecoverable()) throw new IOException("Saved passwords are not damaged");
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    if (keys.containsAlias(alias)) keys.deleteEntry(alias);
    file.delete();
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
    byte[] bytes = file.readFully(); if (bytes.length < PasswordVaultFrame.MIN_FRAME_BYTES || bytes[0] != PasswordVaultFrame.VERSION) throw new IOException("Invalid password storage");
    byte[] plaintext = PasswordVaultFrame.open(key(true), aad, bytes);
    try { return new JSONArray(new String(plaintext, StandardCharsets.UTF_8)); } finally { Arrays.fill(plaintext, (byte)0); }
  }
  private void persist(JSONArray records) throws Exception {
    byte[] plaintext = records.toString().getBytes(StandardCharsets.UTF_8);
    byte[] frame;
    try { frame = PasswordVaultFrame.seal(key(file.getBaseFile().exists()), aad, plaintext); } finally { Arrays.fill(plaintext, (byte)0); }
    FileOutputStream out = null;
    try { out = file.startWrite(); out.write(frame); file.finishWrite(out); }
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
    for (int i = 0; i < records.length(); i++) { JSONObject item = records.getJSONObject(i); summaries.put(new JSONObject().put("id",item.getString("id")).put("origin",item.optString("origin","")).put("username",item.getString("username"))); }
    return summaries;
  }
  /** Facets of a record; legacy records are bound to their single web origin. */
  public static List<String> bindings(JSONObject item) throws Exception {
    List<String> facets = new ArrayList<>();
    JSONArray stored = item.optJSONArray("bindings");
    if (stored != null) for (int i = 0; i < stored.length(); i++) facets.add(stored.getString(i));
    else if (!item.optString("origin","").isEmpty()) facets.add(item.getString("origin"));
    return facets;
  }
  /**
   * Metadata for vault management and fill selection. Never includes the password. Hosts decide
   * which of these fields, if any, may leave native code; none of them is a secret.
   */
  public synchronized JSONArray entries() throws Exception {
    JSONArray records = load(), summaries = new JSONArray();
    for (int i = 0; i < records.length(); i++) {
      JSONObject item = records.getJSONObject(i);
      List<String> facets = bindings(item);
      String label = item.optString("label", "");
      if (label.isEmpty()) label = facets.isEmpty() ? item.getString("username") : facets.get(0);
      summaries.put(new JSONObject().put("id", item.getString("id")).put("label", label).put("username", item.getString("username"))
        .put("bindings", new JSONArray(facets)).put("updatedAt", item.optLong("updatedAt", 0)).put("createdAt", item.optLong("createdAt", item.optLong("updatedAt", 0))));
    }
    return summaries;
  }
  /**
   * Creates (null id) or updates an entry with one or more normalized bindings. A null password
   * keeps the stored one on update and is refused on create. The legacy {@code origin} field
   * holds the first web binding so existing readers keep working.
   */
  public synchronized String saveEntry(String id, String label, String username, List<String> facets, String password) throws Exception {
    String name = label == null ? "" : label.trim();
    if (name.isEmpty() || name.length() > MAX_LABEL) throw new IOException("Enter a name");
    if (username == null || username.length() > MAX_USERNAME) throw new IOException("Enter a shorter username");
    if (password != null && (password.isEmpty() || password.length() > MAX_PASSWORD)) throw new IOException("Enter a password");
    if (facets == null || facets.isEmpty() || facets.size() > MAX_BINDINGS) throw new IOException("Add at least one website or app");
    LinkedHashSet<String> normalized = new LinkedHashSet<>();
    for (String facet : facets) normalized.add(PasswordFacets.normalize(facet));
    String origin = "";
    for (String facet : normalized) if (PasswordFacets.isWeb(facet)) { origin = facet; break; }
    JSONArray records = load(); int found = -1;
    if (id != null) for (int i = 0; i < records.length(); i++) if (records.getJSONObject(i).getString("id").equals(id)) found = i;
    if (id != null && found < 0) throw new IOException("Password no longer exists");
    if (id == null && password == null) throw new IOException("Enter a password");
    if (id == null) { if (records.length() >= MAX_ENTRIES) throw new IOException("Password vault is full"); id = UUID.randomUUID().toString(); }
    long now = System.currentTimeMillis();
    JSONObject previous = found >= 0 ? records.getJSONObject(found) : null;
    JSONObject value = new JSONObject().put("id", id).put("origin", origin).put("username", username)
      .put("password", password != null ? password : previous.getString("password")).put("updatedAt", now)
      .put("createdAt", previous == null ? now : previous.optLong("createdAt", previous.optLong("updatedAt", now)))
      .put("label", name).put("bindings", new JSONArray(new ArrayList<>(normalized)));
    if (found >= 0) records.put(found, value); else records.put(value);
    persist(records); return id;
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
