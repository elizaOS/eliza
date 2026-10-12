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
    private final android.content.Context deviceContext;
    public KeyPolicy(int validitySeconds, boolean biometric) {
      if (validitySeconds < 5 || validitySeconds > 600) throw new IllegalArgumentException("Unsupported password unlock window");
      this.validitySeconds = validitySeconds; this.biometric = biometric; this.deviceContext = null;
    }
    private KeyPolicy(android.content.Context context) {
      if (android.os.Build.VERSION.SDK_INT < 35) throw new IllegalArgumentException("Device-unlocked password custody requires Android 15");
      this.deviceContext = Objects.requireNonNull(context).getApplicationContext();
      this.validitySeconds = 0; this.biometric = false;
    }
    /** New, separately named custody only. Does not change an existing authentication-bound key. */
    public static KeyPolicy deviceUnlocked(android.content.Context context) { return new KeyPolicy(context); }
    public boolean requiresDeviceUnlockOnly() { return deviceContext != null; }
    private void checkDevice() throws DeviceLocked {
      if (deviceContext == null) return;
      android.app.KeyguardManager guard = deviceContext.getSystemService(android.app.KeyguardManager.class);
      android.os.UserManager user = deviceContext.getSystemService(android.os.UserManager.class);
      if (guard == null || user == null || !user.isUserUnlocked() || !guard.isDeviceSecure() || guard.isDeviceLocked()) throw new DeviceLocked();
    }
    int authenticators() { return biometric ? KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL : KeyProperties.AUTH_DEVICE_CREDENTIAL; }
  }
  public static final int MAX_ENTRIES = 1000, MAX_BINDINGS = 20, MAX_LABEL = 200, MAX_USERNAME = 1024, MAX_PASSWORD = 16384;
  private final AtomicFile file;
  private final AtomicFile devicePolicyFile;
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
    this.devicePolicyFile = policy != null && policy.requiresDeviceUnlockOnly() ? new AtomicFile(new File(directory, "vault.device-unlocked-v1")) : null;
    this.file = new AtomicFile(new File(directory, "vault.enc")); this.alias = alias; this.policy = policy; this.authenticationRequired = policy != null && !policy.requiresDeviceUnlockOnly();
  }
  /** Device lock and screen-lock removal deny access without starting an app authentication prompt. */
  public static final class DeviceLocked extends IOException { DeviceLocked() { super("Unlock the device to use saved passwords"); } }
  private void checkDevice() throws DeviceLocked { if (policy != null) policy.checkDevice(); }
  private SecretKey key(boolean existing) throws Exception {
    synchronized (PasswordVaultStore.class) { return keyLocked(existing); }
  }
  private SecretKey keyLocked(boolean existing) throws Exception {
    checkDevice();
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    if (keys.containsAlias(alias)) {
      SecretKey key=(SecretKey)keys.getKey(alias,null);
      android.security.keystore.KeyInfo info=(android.security.keystore.KeyInfo)SecretKeyFactory.getInstance(key.getAlgorithm(),"AndroidKeyStore").getKeySpec(key,android.security.keystore.KeyInfo.class);
      if (policy != null && policy.requiresDeviceUnlockOnly() && info.isUserAuthenticationRequired()) throw new IOException("Password key authentication policy mismatch");
      if (authenticationRequired && (!info.isUserAuthenticationRequired() || info.getUserAuthenticationValidityDurationSeconds()!=policy.validitySeconds)) throw new IOException("Password key authentication policy mismatch");
      if (authenticationRequired && android.os.Build.VERSION.SDK_INT>=30 && info.getUserAuthenticationType()!=policy.authenticators()) throw new IOException("Password key authenticator policy mismatch");
      if (devicePolicyFile != null) verifyDeviceKeyProvenance(key);
      return key;
    }
    if (existing || (devicePolicyFile != null && (devicePolicyFile.getBaseFile().exists() || new File(devicePolicyFile.getBaseFile().getPath() + ".bak").exists()))) throw new KeyLost();
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true);
    if (authenticationRequired) {
      spec.setUserAuthenticationRequired(true);
      if (android.os.Build.VERSION.SDK_INT>=30) spec.setUserAuthenticationParameters(policy.validitySeconds,policy.authenticators());
      else spec.setUserAuthenticationValidityDurationSeconds(policy.validitySeconds);
    }
    if (android.os.Build.VERSION.SDK_INT >= 28) spec.setUnlockedDeviceRequired(true);
    generator.init(spec.build());
    SecretKey generated = generator.generateKey();
    if (devicePolicyFile != null) {
      byte[] marker = PasswordVaultFrame.seal(generated, devicePolicyAad(), devicePolicyValue());
      FileOutputStream output = null;
      try { output = devicePolicyFile.startWrite(); output.write(marker); devicePolicyFile.finishWrite(output); }
      catch (Exception failure) { if (output != null) devicePolicyFile.failWrite(output); throw failure; }
      verifyDeviceKeyProvenance(generated);
    }
    return generated;
  }
  private byte[] devicePolicyAad() {
    byte[] tag = "device-unlocked-key-provenance-v1".getBytes(StandardCharsets.UTF_8);
    byte[] combined = Arrays.copyOf(aad, aad.length + tag.length);
    System.arraycopy(tag, 0, combined, aad.length, tag.length); return combined;
  }
  private byte[] devicePolicyValue() { return ("device-unlocked-v1:" + alias).getBytes(StandardCharsets.UTF_8); }
  /** KeyInfo cannot report unlockedDeviceRequired. Admit only keys created by this versioned path. */
  private void verifyDeviceKeyProvenance(SecretKey key) throws Exception {
    File base = devicePolicyFile.getBaseFile(), backup = new File(base.getPath() + ".bak");
    if (!base.exists() && !backup.exists()) throw new IOException("Device-unlocked key provenance is missing");
    for (File candidate : new File[]{base, backup})
      if (java.nio.file.Files.isSymbolicLink(candidate.toPath()) || (candidate.exists() && (!candidate.isFile() || candidate.length() > 4096)))
        throw new IOException("Invalid device-unlocked key provenance");
    byte[] value = PasswordVaultFrame.open(key, devicePolicyAad(), devicePolicyFile.readFully());
    try { if (!Arrays.equals(value, devicePolicyValue())) throw new IOException("Invalid device-unlocked key provenance"); }
    finally { Arrays.fill(value, (byte)0); }
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
    checkDevice();
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
    if (devicePolicyFile != null) devicePolicyFile.delete();
  }

  public android.security.keystore.KeyInfo keyProtection() throws Exception {
    SecretKey key=key(false);
    return (android.security.keystore.KeyInfo)SecretKeyFactory.getInstance(key.getAlgorithm(),"AndroidKeyStore").getKeySpec(key,android.security.keystore.KeyInfo.class);
  }
  private JSONArray load() throws Exception {
    checkDevice();
    File base=file.getBaseFile(), backup=new File(base.getPath()+".bak");
    if (!base.exists() && !backup.exists()) return new JSONArray();
    // AtomicFile must recover a committed legacy backup before a missing base
    // can be treated as an empty vault. Never overwrite recoverable records.
    for (File candidate : new File[]{base,backup}) {
      if (java.nio.file.Files.isSymbolicLink(candidate.toPath()) || (candidate.exists() && (!candidate.isFile() || candidate.length()>4*1024*1024))) throw new IOException("Invalid password storage");
    }
    byte[] bytes = file.readFully(); if (bytes.length < PasswordVaultFrame.MIN_FRAME_BYTES || bytes[0] != PasswordVaultFrame.VERSION) throw new IOException("Invalid password storage");
    byte[] plaintext = PasswordVaultFrame.open(key(true), aad, bytes);
    try { JSONArray records = new JSONArray(new String(plaintext, StandardCharsets.UTF_8)); checkDevice(); return records; } finally { Arrays.fill(plaintext, (byte)0); }
  }
  private void persist(JSONArray records) throws Exception {
    checkDevice();
    byte[] plaintext = records.toString().getBytes(StandardCharsets.UTF_8);
    byte[] frame;
    try { frame = PasswordVaultFrame.seal(key(file.getBaseFile().exists()), aad, plaintext); } finally { Arrays.fill(plaintext, (byte)0); }
    FileOutputStream out = null;
    try { out = file.startWrite(); out.write(frame); file.finishWrite(out); }
    catch (Exception failure) { if (out != null) file.failWrite(out); throw failure; }
    File target = file.getBaseFile(); target.setReadable(false, false); target.setReadable(true, true); target.setWritable(false, false); target.setWritable(true, true);
  }
  /**
   * Copy an authenticated native snapshot into a distinct device-unlocked vault. Preserve the
   * source alias, file, IDs and timestamps. A repeated attempt only succeeds when the target
   * already contains the exact same snapshot; never replace unrelated target data.
   *
   * The host must keep using the source until this method returns and it durably commits its
   * selected custody version. A crash before that host commit can retry this method. Conflicting
   * snapshots require explicit recovery. No host selection or source deletion occurs here.
   * An absent source contains no secret and may produce an empty snapshot without a challenge.
   */
  public synchronized int migrateToDeviceUnlocked(PasswordVaultStore target) throws Exception {
    if (!authenticationRequired || target == null || target.policy == null || !target.policy.requiresDeviceUnlockOnly()
        || alias.equals(target.alias) || file.getBaseFile().getCanonicalFile().equals(target.file.getBaseFile().getCanonicalFile()))
      throw new IOException("Use a separate device-unlocked password vault");
    JSONArray snapshot = load(); // The old Keystore key still enforces its original authentication.
    synchronized (target) {
      target.checkDevice();
      File base = target.file.getBaseFile();
      if (base.exists() || new File(base.getPath() + ".bak").exists()) {
        if (!snapshot.toString().equals(target.load().toString())) throw new IOException("Password migration target already contains different records");
      } else {
        target.persist(snapshot);
        if (!snapshot.toString().equals(target.load().toString())) throw new IOException("Password migration verification failed");
      }
      target.checkDevice();
      return snapshot.length();
    }
  }

  public static String origin(String input) throws Exception {
    URI uri = new URI(input.trim());
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || uri.getRawPath().equals("/")) || uri.getPort() < -1 || uri.getPort() > 65535) throw new IOException("Use an HTTPS website address without a path");
    return new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT), uri.getPort() == 443 ? -1 : uri.getPort(), null, null, null).toASCIIString();
  }
  public synchronized JSONArray list() throws Exception {
    JSONArray records = load(), summaries = new JSONArray();
    for (int i = 0; i < records.length(); i++) { JSONObject item = records.getJSONObject(i); summaries.put(new JSONObject().put("id",item.getString("id")).put("origin",item.optString("origin","")).put("username",item.getString("username"))); }
    checkDevice(); return summaries;
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
      String label = entryLabel(item, facets);
      summaries.put(new JSONObject().put("id", item.getString("id")).put("label", label).put("username", item.getString("username"))
        .put("bindings", new JSONArray(facets)).put("updatedAt", item.optLong("updatedAt", 0)).put("createdAt", item.optLong("createdAt", item.optLong("updatedAt", 0))));
    }
    checkDevice(); return summaries;
  }
  private static String entryLabel(JSONObject item, List<String> facets) throws Exception {
    String label = item.optString("label", "");
    return label.isEmpty() ? (facets.isEmpty() ? item.getString("username") : facets.get(0)) : label;
  }
  /** One native export snapshot. Contains passwords: never return it through a bridge or log it. */
  public synchronized JSONArray exportEntries() throws Exception {
    JSONArray records = load();
    for (int i = 0; i < records.length(); i++) {
      JSONObject item = records.getJSONObject(i);
      item.put("label", entryLabel(item, bindings(item)));
    }
    checkDevice(); return records;
  }
  /**
   * Creates (null id) or updates an entry with one or more normalized bindings. A null password
   * keeps the stored one on update and is refused on create. The legacy {@code origin} field
   * holds the first web binding so existing readers keep working.
   */
  public synchronized String saveEntry(String id, String label, String username, List<String> facets, String password) throws Exception {
    JSONArray records = load();
    String saved = putEntry(records, id, label, username, facets, password);
    persist(records);
    return saved;
  }

  /** Add reviewed web entries in one commit. Recheck duplicates against current storage.
   * Validate the complete batch before persisting; validation or capacity failure leaves
   * the previously committed vault intact. Persistence uses the existing atomic writer. */
  public synchronized int addWebsiteEntries(JSONArray incoming) throws Exception {
    JSONArray records = load();
    java.util.Set<String> existing = new java.util.HashSet<>();
    for (int i = 0; i < records.length(); i++) {
      JSONObject record = records.getJSONObject(i);
      for (String facet : bindings(record)) if (PasswordFacets.isWeb(facet))
        existing.add(facet + "\n" + record.getString("username"));
    }
    int added = 0;
    for (int i = 0; i < incoming.length(); i++) {
      JSONObject item = incoming.getJSONObject(i);
      String origin = PasswordFacets.web(item.getString("origin"));
      String username = item.getString("username");
      if (!existing.add(origin + "\n" + username)) continue;
      putEntry(records, null, item.getString("label"), username,
        java.util.Collections.singletonList(origin), item.getString("password"));
      added++;
    }
    if (added > 0) persist(records);
    return added;
  }

  private static String putEntry(JSONArray records, String id, String label, String username, List<String> facets, String password) throws Exception {
    String name = label == null ? "" : label.trim();
    if (name.isEmpty() || name.length() > MAX_LABEL) throw new IOException("Enter a name");
    if (username == null || username.length() > MAX_USERNAME) throw new IOException("Enter a shorter username");
    if (password != null && (password.isEmpty() || password.length() > MAX_PASSWORD)) throw new IOException("Enter a password");
    if (facets == null || facets.isEmpty() || facets.size() > MAX_BINDINGS) throw new IOException("Add at least one website or app");
    LinkedHashSet<String> normalized = new LinkedHashSet<>();
    for (String facet : facets) normalized.add(PasswordFacets.normalize(facet));
    String origin = "";
    for (String facet : normalized) if (PasswordFacets.isWeb(facet)) { origin = facet; break; }
    int found = -1;
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
    return id;
  }
  public synchronized JSONObject get(String id) throws Exception {
    JSONArray records=load(); for(int i=0;i<records.length();i++) if(records.getJSONObject(i).getString("id").equals(id)) { checkDevice(); return records.getJSONObject(i); } throw new IOException("Password no longer exists");
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
