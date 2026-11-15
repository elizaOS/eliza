import ai.eliza.plugins.securestore.nativeonly.JsonCredentialSlots;
import java.io.File;
/** Reused from eliza-research/alpha@d7ede2eed30ff14558dc675d39f5548c75bdc4c8:
 * test/fixtures/secure-store-memory/MemoryTest.java. The memory and custody assertions are unchanged. */
public final class JsonCredentialSlotsMemoryTest {
 /** A valid JSON string value of exactly n UTF-8 bytes. */
 private static String json(int n){byte[] bytes=new byte[n];java.util.Arrays.fill(bytes,(byte)'x');bytes[0]=bytes[n-1]='"';return new String(bytes,java.nio.charset.StandardCharsets.US_ASCII);}
 public static void main(String[] args)throws Exception{
  final int cap=32*1024*1024;
  JsonCredentialSlots store=new JsonCredentialSlots(new File(args[0]),"fixture",slot->cap);
  // Same nested serialized envelope shape that exhausted the Android 192 MiB heap.
  String prefix="{\"currentRaw\":\"{\\\"body\\\":\\\"",suffix="\\\"}\"}";
  String value=prefix+"F".repeat(cap-prefix.length()-suffix.length())+suffix;
  System.out.println("write");store.write("large",value);
  // Keep a modest resident allocation alive alongside an expected renderer value.
  // This is still a host cipher provider, not a claim about AndroidKeyStore.
  byte[] resident=new byte[24*1024*1024];resident[resident.length-1]=73;
  System.out.println("read");if(!value.equals(store.read("large")))throw new AssertionError("Read changed bytes");
  if(resident[resident.length-1]!=73)throw new AssertionError();resident=null;
  System.out.println("CAS");if(!store.compareExchange("large",value,"{}"))throw new AssertionError("CAS failed");value=null;
  if(!"{}".equals(store.read("large")))throw new AssertionError("CAS not persisted");
  for(String invalid:new String[]{"{broken","{} trailing","[1,2"}){
   try{store.write("large",invalid);throw new AssertionError("Invalid JSON accepted");}catch(org.json.JSONException|IllegalArgumentException expected){}
   if(!"{}".equals(store.read("large")))throw new AssertionError("Invalid JSON changed slot");
  }
  for(String invalid:new String[]{"{broken","{} trailing","[1,2"}){
   javax.crypto.Cipher cipher=javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
   cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,new javax.crypto.spec.SecretKeySpec(new byte[32],"AES"));
   cipher.updateAAD(store.slotHash("large").getBytes(java.nio.charset.StandardCharsets.US_ASCII));
   try(java.io.FileOutputStream out=new java.io.FileOutputStream(store.slotFile(store.slotHash("large")).getBaseFile())){
    out.write(1);out.write(12);out.write(cipher.getIV());out.write(cipher.doFinal(invalid.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
   }
   try{store.read("large");throw new AssertionError("Authenticated invalid JSON accepted");}catch(org.json.JSONException|IllegalArgumentException expected){}
  }
  // A valid v1 ciphertext must authenticate as a whole, even after streamed updates.
  for(int mode=0;mode<4;mode++){
   store.write("tamper","{\"body\":\""+"F".repeat(40000)+"\"}");
   java.nio.file.Path path=store.slotFile(store.slotHash("tamper")).getBaseFile().toPath();
   byte[] bytes=java.nio.file.Files.readAllBytes(path);
   if(mode==0)bytes[bytes.length-1]^=1;
   if(mode==1)bytes[17000]^=1;
   if(mode==2)bytes=java.util.Arrays.copyOf(bytes,bytes.length-1);
   if(mode==3)bytes=java.util.Arrays.copyOf(bytes,bytes.length+1);
   java.nio.file.Files.write(path,bytes);
   try{store.read("tamper");throw new AssertionError("Unauthenticated stream returned: "+mode);}catch(javax.crypto.AEADBadTagException expected){}
  }
  // The deployed slot hash remains the authenticated context, not only a filename.
  store.write("aad","{}");
  java.nio.file.Files.copy(store.slotFile(store.slotHash("aad")).getBaseFile().toPath(),store.slotFile(store.slotHash("foreign-aad")).getBaseFile().toPath());
  try{store.read("foreign-aad");throw new AssertionError("Wrong slot AAD accepted");}catch(javax.crypto.AEADBadTagException expected){}
  if(!"{}".equals(store.read("aad")))throw new AssertionError("AAD refusal changed the original slot");
  store.remove("aad");store.remove("foreign-aad");
  store.write("large","{}");
  if(store.compareExchange("large","wrong","null"))throw new AssertionError("Stale CAS accepted");
  for(int mode=1;mode<=4;mode++){
   android.util.AtomicFile.corruptNextCommit=mode;
   try{store.write("corrupt","{}");throw new AssertionError("Corrupted committed bytes accepted: "+mode);}catch(IllegalStateException expected){}
  }
  // A reduced host limit must retain old data, permit shrinking, and refuse growth.
  String retained="{\"body\":\""+"R".repeat(60000)+"\"}";
  store.write("retained",retained);
  JsonCredentialSlots reduced=new JsonCredentialSlots(new File(args[0]),"fixture",slot->32768,slot->cap);
  if(!retained.equals(reduced.read("retained")))throw new AssertionError("Retained limit lost old data");
  String shrunk="{\"body\":\""+"R".repeat(50000)+"\"}";
  reduced.write("retained",shrunk);
  try{reduced.write("retained",retained);throw new AssertionError("Retained data grew");}catch(JsonCredentialSlots.CapacityException expected){}
  if(!shrunk.equals(reduced.read("retained")))throw new AssertionError("Capacity refusal changed bytes");
  try{reduced.write("new-retained",retained);throw new AssertionError("New oversized slot accepted");}catch(JsonCredentialSlots.CapacityException expected){}
  reduced.write("retained","{}");
  try{reduced.write("retained",shrunk);throw new AssertionError("Shrunk slot grew past new cap");}catch(JsonCredentialSlots.CapacityException expected){}
  // The lowered Notes Trash cap (30 MiB, retained 32 MiB) with a document written under the older
  // cap, in the order NotesStorageDurabilityInstrumentedTest drives it on Android: the caller keeps
  // the stored value and the proposed value alive while the slot decides growth versus shrink.
  final int lowered=30*1024*1024;
  JsonCredentialSlots trash=new JsonCredentialSlots(new File(args[0]),"fixture",slot->lowered,slot->cap);
  String oversize=json(lowered+4096);store.write("trash",oversize);
  System.out.println("lowered read");if(!oversize.equals(trash.read("trash")))throw new AssertionError("Older oversize Trash unreadable");
  System.out.println("lowered growth");
  try{trash.write("trash",json(lowered+8192));throw new AssertionError("Growth above the lowered cap accepted");}catch(JsonCredentialSlots.CapacityException expected){}
  if(!oversize.equals(trash.read("trash")))throw new AssertionError("Refused growth changed bytes");
  System.out.println("lowered shrink");
  String smaller=json(lowered+1024);
  if(!trash.compareExchange("trash",oversize,smaller))throw new AssertionError("Shrink above the lowered cap refused");oversize=null;
  if(!smaller.equals(trash.read("trash")))throw new AssertionError("Shrink not persisted");
  String fits=json(lowered);if(!trash.compareExchange("trash",smaller,fits))throw new AssertionError("Value at the lowered cap refused");smaller=null;
  try{trash.write("trash",json(lowered+1));throw new AssertionError("Growth above the lowered cap accepted again");}catch(JsonCredentialSlots.CapacityException expected){}
  if(!fits.equals(trash.read("trash")))throw new AssertionError("Final refusal changed bytes");fits=null;
  trash.remove("trash");
  System.out.println("PASS 32 MiB authenticated write/read/CAS with 192 MiB heap");
 }
}
