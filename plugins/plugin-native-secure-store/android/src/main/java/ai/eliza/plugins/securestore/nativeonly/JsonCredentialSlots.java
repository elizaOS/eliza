package ai.eliza.plugins.securestore.nativeonly;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONTokener;

/** Native-only JSON slots with host-owned identity and size policy.
 * Format: version byte 1, IV-length byte 12, IV, AES-GCM ciphertext/tag.
 * Slot filenames and AAD are the lower-case SHA-256 hex digest of the UTF-8 slot.
 * All instances share one process lock, including cold key creation and CAS.
 * Not a cross-process lock: hosts must keep writers in one Android process.
 */
public final class JsonCredentialSlots {
 public static final Object LOCK=new Object();
 public interface Limits { int maxBytes(String slot); }
 private final File directory;
 private final String alias;
 private final Limits limits;
 public JsonCredentialSlots(File directory,String alias,Limits limits){
  this.directory=java.util.Objects.requireNonNull(directory);
  this.alias=required(alias,1024);
  this.limits=java.util.Objects.requireNonNull(limits);
 }
 private static String required(String value, int max) {
  if (value == null || value.isEmpty() || value.length() > max) throw new IllegalArgumentException();
  return value;
 }
 private int slotLimit(String slot){
  int value=limits.maxBytes(slot);
  if(value<1||value>Integer.MAX_VALUE-64)throw new IllegalArgumentException("Invalid credential slot limit");
  return value;
 }
 public String slotHash(String slot) throws Exception {
  byte[] hash = MessageDigest.getInstance("SHA-256").digest(required(slot, 1024).getBytes(StandardCharsets.UTF_8));
  StringBuilder result = new StringBuilder();
  for (byte b : hash) result.append(String.format(Locale.ROOT, "%02x", b & 255));
  return result.toString();
 }
 public AtomicFile slotFile(String hash) throws Exception {
  if(!hash.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid slot hash");
  if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException();
  return new AtomicFile(new File(directory, hash));
 }
 private SecretKey key() throws Exception {
  KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
  if (!store.containsAlias(alias)) {
   KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
   generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
     .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
   generator.generateKey();
  }
  return (SecretKey) store.getKey(alias, null);
 }
 private static Object parseJson(String value) throws Exception {
  JSONTokener parser = new JSONTokener(value);
  Object parsed = parser.nextValue();
  if (parser.nextClean() != 0) throw new IllegalArgumentException();
  return parsed;
 }
 public void write(String name, String serialized) throws Exception {
    String slot = slotHash(name);
    int limit=slotLimit(name);
    String value = required(serialized, limit);
    parseJson(value);
    byte[] plain = value.getBytes(StandardCharsets.UTF_8);
    try {
    if (plain.length > limit) throw new IllegalArgumentException();
    synchronized (LOCK) {
     Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
     cipher.updateAAD(slot.getBytes(StandardCharsets.US_ASCII));
     byte[] iv = cipher.getIV(), encrypted = cipher.doFinal(plain);
     AtomicFile file = slotFile(slot); FileOutputStream out = null;
     try {
      out = file.startWrite(); out.write(1); out.write(iv.length); out.write(iv); out.write(encrypted);
      out.getFD().sync(); file.finishWrite(out);
      out = null;
      try (InputStream input = file.openRead()) {
       byte[] committed = readBounded(input, limit + 64);
       if (committed.length != 2 + iv.length + encrypted.length || committed[0] != 1 || committed[1] != iv.length
         || !Arrays.equals(iv, Arrays.copyOfRange(committed, 2, 2 + iv.length))
         || !Arrays.equals(encrypted, Arrays.copyOfRange(committed, 2 + iv.length, committed.length))) throw new IllegalStateException();
      }
     } catch (Exception error) { if (out != null) file.failWrite(out); throw error; }
    }
    } finally { Arrays.fill(plain, (byte) 0); }
 }
 /** Native consumers share the same authenticated slot format without a JS credential round trip. */
 public String read(String name) throws Exception {
  String slot=slotHash(name);int limit=slotLimit(name);
  synchronized(LOCK) {
   AtomicFile file=slotFile(slot); byte[] stored;
   try(InputStream input=file.openRead()){stored=readBounded(input,limit+64);}
   catch(FileNotFoundException missing){if(file.getBaseFile().exists()||new File(file.getBaseFile().getPath()+".bak").exists())throw missing;return null;}
   if(stored.length<30||stored[0]!=1||stored[1]!=12)throw new IllegalArgumentException();
   Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
   cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Arrays.copyOfRange(stored,2,14)));
   cipher.updateAAD(slot.getBytes(StandardCharsets.US_ASCII));
   byte[] plain=cipher.doFinal(stored,14,stored.length-14);
   try{if(plain.length>limit)throw new IllegalArgumentException("Credential slot exceeds byte limit");String value=new String(plain,StandardCharsets.UTF_8);parseJson(value);return value;}
   finally{Arrays.fill(plain,(byte)0);}
  }
 }
 public void remove(String name)throws Exception {
  synchronized(LOCK){
   AtomicFile file=slotFile(slotHash(name));file.delete();
   if(file.getBaseFile().exists()||new File(file.getBaseFile()+".bak").exists()||new File(file.getBaseFile()+".new").exists())throw new java.io.IOException("Secure slot removal failed");
  }
 }
 public boolean compareExchange(String slot,String expected,String value)throws Exception{
  synchronized(LOCK){
   if(!java.util.Objects.equals(expected,read(slot)))return false;
   if(value==null)remove(slot);else write(slot,value);
   return true;
  }
 }
 private static byte[] readBounded(InputStream input, int limit) throws Exception {
  if (input == null) return new byte[0];
  ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
  while ((count = input.read(buffer)) != -1) {
   if (output.size() + count > limit) throw new IllegalArgumentException();
   output.write(buffer, 0, count);
  }
  return output.toByteArray();
 }
}
