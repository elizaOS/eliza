package ai.eliza.plugins.securestore.nativeonly;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
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
 * A host that lowers a slot limit can keep a retained limit for data written under the old
 * limit: such a slot stays readable, and a write that does not grow it is accepted, until it
 * fits the new limit again.
 */
public final class JsonCredentialSlots {
 public static final Object LOCK=new Object();
 public interface Limits { int maxBytes(String slot); }
 /** A definite size refusal before any byte is written: the value does not fit its slot. */
 public static final class CapacityException extends IllegalArgumentException {
  private static final long serialVersionUID = 1L;
  CapacityException(){super("Credential slot is full");}
 }
 private final File directory;
 private final String alias;
 private final Limits limits,retained;
 public JsonCredentialSlots(File directory,String alias,Limits limits){this(directory,alias,limits,limits);}
 /** {@code retained} bounds data already stored under an older, larger limit. It is never below
  * {@code limits}: reads accept it, and writes above {@code limits} are accepted only up to the
  * stored value's size. */
 public JsonCredentialSlots(File directory,String alias,Limits limits,Limits retained){
  this.directory=java.util.Objects.requireNonNull(directory);
  this.alias=required(alias,1024);
  this.limits=java.util.Objects.requireNonNull(limits);
  this.retained=java.util.Objects.requireNonNull(retained);
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
 private int retainedLimit(String slot){
  int value=retained.maxBytes(slot);
  if(value<slotLimit(slot)||value>Integer.MAX_VALUE-64)throw new IllegalArgumentException("Invalid credential slot limit");
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
    int limit=slotLimit(name),ceiling=retainedLimit(name);
    if (serialized == null || serialized.isEmpty()) throw new IllegalArgumentException();
    if (serialized.length() > ceiling) throw new CapacityException();
    String value = serialized;
    parseJson(value);
    byte[] plain = value.getBytes(StandardCharsets.UTF_8);
    try {
    if (plain.length > ceiling) throw new CapacityException();
    synchronized (LOCK) {
     if (plain.length > limit) {
      // Above the current limit only while shrinking data written under the older limit.
      long stored = storedPlaintextLength(slot);
      if (stored < plain.length) throw new CapacityException();
     }
     Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
     cipher.updateAAD(slot.getBytes(StandardCharsets.US_ASCII));
     byte[] iv = cipher.getIV(), encrypted = cipher.doFinal(plain);
     AtomicFile file = slotFile(slot); FileOutputStream out = null;
     try {
      out = file.startWrite(); out.write(1); out.write(iv.length); out.write(iv); out.write(encrypted);
      out.getFD().sync(); file.finishWrite(out);
      out = null;
      try (InputStream input = file.openRead()) {
       if(input.read()!=1||input.read()!=iv.length)throw new IllegalStateException();
       verifyBytes(input,iv);verifyBytes(input,encrypted);
       if(input.read()!=-1)throw new IllegalStateException();
      }
     } catch (Exception error) { if (out != null) file.failWrite(out); throw error; }
    }
    } finally { Arrays.fill(plain, (byte) 0); }
 }
 /** Native consumers share the same authenticated slot format without a JS credential round trip. */
 public String read(String name) throws Exception {
  String slot=slotHash(name);int limit=retainedLimit(name);
  synchronized(LOCK) {
   String value=readAuthenticated(slot,limit);
   if(value!=null)parseJson(value);
   return value;
  }
 }
 /** End the ciphertext/plaintext buffer lifetimes before parsing nested JSON strings. */
 private String readAuthenticated(String slot,int limit)throws Exception {
   AtomicFile file=slotFile(slot);
   try(InputStream input=file.openRead()){
    if(input.read()!=1||input.read()!=12)throw new IllegalArgumentException();
    byte[] iv=new byte[12];int offset=0;
    while(offset<iv.length){int count=input.read(iv,offset,iv.length-offset);if(count<1)throw new IllegalArgumentException();offset+=count;}
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,iv));
    cipher.updateAAD(slot.getBytes(StandardCharsets.US_ASCII));
    // AndroidKeyStore itself buffers GCM plaintext until tag verification. Do not
    // retain a second full ciphertext array alongside that provider-owned buffer.
    java.util.ArrayList<byte[]> pieces=new java.util.ArrayList<>();
    byte[] buffer=new byte[16384];int encrypted=0,plain=0;
    try{
     int count;
     while((count=input.read(buffer))!=-1){
      if(count==0)continue;
      if(count>limit+16-encrypted)throw new IllegalArgumentException("Credential slot exceeds byte limit");encrypted+=count;
      byte[] piece=cipher.update(buffer,0,count);
      if(piece!=null&&piece.length>0){pieces.add(piece);if(piece.length>limit-plain)throw new IllegalArgumentException("Credential slot exceeds byte limit");plain+=piece.length;}
     }
     byte[] last=cipher.doFinal(); // Authenticate everything before returning any plaintext.
     pieces.add(last);if(last.length>limit-plain)throw new IllegalArgumentException("Credential slot exceeds byte limit");plain+=last.length;
     if(pieces.size()==1)return new String(last,StandardCharsets.UTF_8);
     byte[] joined=new byte[plain];int position=0;
     try{for(byte[] piece:pieces){System.arraycopy(piece,0,joined,position,piece.length);position+=piece.length;}return new String(joined,StandardCharsets.UTF_8);}
     finally{Arrays.fill(joined,(byte)0);}
    }finally{Arrays.fill(buffer,(byte)0);for(byte[] piece:pieces)Arrays.fill(piece,(byte)0);}
   }catch(FileNotFoundException missing){if(file.getBaseFile().exists()||new File(file.getBaseFile().getPath()+".bak").exists())throw missing;return null;}
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
 /**
  * The stored value's UTF-8 length, from the committed v1 file: AES/GCM ciphertext is the plaintext
  * plus its 16-byte tag. Counted in chunks, so a shrink check above the current limit holds no second
  * decrypted copy, String or byte array of a slot-sized value beside the one being written. It decides
  * admission only, never returns plaintext; the value written replaces the whole file. -1 when absent.
  */
 private long storedPlaintextLength(String slot)throws Exception{
  AtomicFile file=slotFile(slot);
  try(InputStream input=file.openRead()){
   if(input.read()!=1||input.read()!=12)throw new IllegalArgumentException();
   byte[] buffer=new byte[8192];long count=0;int read;
   while((read=input.read(buffer))!=-1)count+=read;
   if(count<12+16)throw new IllegalArgumentException();
   return count-12-16;
  }catch(FileNotFoundException missing){if(file.getBaseFile().exists()||new File(file.getBaseFile().getPath()+".bak").exists())throw missing;return -1;}
 }
 /** Verify the committed ciphertext without another slot-sized array or slice. */
 private static void verifyBytes(InputStream input,byte[] expected)throws Exception{
  byte[] buffer=new byte[8192];int offset=0;
  while(offset<expected.length){
   int count=input.read(buffer,0,Math.min(buffer.length,expected.length-offset));
   if(count<1)throw new IllegalStateException();
   for(int i=0;i<count;i++)if(buffer[i]!=expected[offset+i])throw new IllegalStateException();
   offset+=count;
  }
 }
}
