package ai.eliza.plugins.securestore.nativeonly;

import android.util.AtomicFile;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import org.junit.Test;
import static org.junit.Assert.*;

/** Synthetic JSON only. Real Android Keystore and the deployed two-byte header. */
public final class JsonCredentialSlotsInstrumentedTest {
 private static final class Fixture implements AutoCloseable {
  final File root=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getNoBackupFilesDir(),"json-slots-"+UUID.randomUUID());
  final String alias="eliza.json-slots-test."+UUID.randomUUID();
  final KeyStore keys=KeyStore.getInstance("AndroidKeyStore");
  Fixture()throws Exception{assertTrue(root.mkdirs());keys.load(null);}
  JsonCredentialSlots store(){return new JsonCredentialSlots(root,alias,slot->1024);}
  @Override public void close()throws Exception{for(File file:root.listFiles())assertTrue(file.delete());assertTrue(root.delete());keys.deleteEntry(alias);}
 }
 @Test public void deployedFrameBackupAndAuthenticatedSlotArePreserved()throws Exception{
  try(Fixture f=new Fixture()){
   JsonCredentialSlots store=f.store();String slot="example:v1:device",value=" {\"fixture\":\"synthetic 🔑\"}\n";
   assertNull(store.read(slot));store.write(slot,value);assertEquals(value,f.store().read(slot));
   AtomicFile file=store.slotFile(store.slotHash(slot));byte[] bytes=Files.readAllBytes(file.getBaseFile().toPath());
   assertEquals(1,bytes[0]);assertEquals(12,bytes[1]);assertFalse(new String(bytes,StandardCharsets.UTF_8).contains("synthetic"));
   SecretKey key=(SecretKey)f.keys.getKey(f.alias,null);assertNull(key.getEncoded());
   // Produce an independent old-writer frame: version, IV length, IV, ciphertext/tag.
   Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key);cipher.updateAAD(store.slotHash(slot).getBytes(StandardCharsets.US_ASCII));
   byte[] ciphertext=cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
   try(FileOutputStream out=new FileOutputStream(file.getBaseFile())){out.write(1);out.write(cipher.getIV().length);out.write(cipher.getIV());out.write(ciphertext);}
   byte[] old=Files.readAllBytes(file.getBaseFile().toPath());assertEquals(value,f.store().read(slot));assertArrayEquals(old,Files.readAllBytes(file.getBaseFile().toPath()));
   File backup=new File(file.getBaseFile()+".bak");Files.move(file.getBaseFile().toPath(),backup.toPath());assertEquals(value,f.store().read(slot));assertFalse(backup.exists());
   File wrong=store.slotFile(store.slotHash("different-slot")).getBaseFile();Files.copy(file.getBaseFile().toPath(),wrong.toPath());
   try{store.read("different-slot");fail("Wrong slot AAD accepted");}catch(javax.crypto.AEADBadTagException expected){}
   bytes=Files.readAllBytes(file.getBaseFile().toPath());bytes[bytes.length-1]^=1;Files.write(file.getBaseFile().toPath(),bytes);
   try{store.read(slot);fail("Tampered ciphertext accepted");}catch(javax.crypto.AEADBadTagException expected){}
   store.remove(slot);assertNull(store.read(slot));store.remove("different-slot");
  }
 }
 @Test public void independentInstancesSerializeColdKeysAndCompareExchange()throws Exception{
  try(Fixture f=new Fixture()){
   ExecutorService pool=Executors.newFixedThreadPool(8);
   try{
    CountDownLatch start=new CountDownLatch(1);List<Future<Boolean>> contenders=new ArrayList<>();
    for(int i=0;i<8;i++){final int index=i;contenders.add(pool.submit(()->{start.await();JsonCredentialSlots store=f.store();store.write("own:"+index,"{\"index\":"+index+"}");return store.compareExchange("winner",null,"{\"index\":"+index+"}");}));}
    start.countDown();int winners=0;for(Future<Boolean> result:contenders)if(result.get(30,TimeUnit.SECONDS))winners++;assertEquals(1,winners);
    for(int i=0;i<8;i++)assertEquals("{\"index\":"+i+"}",f.store().read("own:"+i));
    JsonCredentialSlots store=f.store();String previous=store.read("winner");assertFalse(store.compareExchange("winner","{}",null));assertEquals(previous,store.read("winner"));
    assertTrue(store.compareExchange("winner",previous,"null"));assertEquals("null",store.read("winner"));assertTrue(store.compareExchange("winner","null",null));assertNull(store.read("winner"));
   }finally{pool.shutdownNow();assertTrue(pool.awaitTermination(30,TimeUnit.SECONDS));}
  }
 }
 @Test public void hostLimitsCountUtf8BytesAndRejectedWritesPreserveCommittedData()throws Exception{
  try(Fixture f=new Fixture()){
   JsonCredentialSlots store=f.store();store.write("bounded","{}");
   for(String rejected:new String[]{"", "{} trailing", "\""+new String(new char[400]).replace('\0','界')+"\""}){
    try{store.write("bounded",rejected);fail("Invalid JSON/size accepted");}catch(Exception expected){}
    assertEquals("{}",store.read("bounded"));
   }
   String maximum="\""+new String(new char[1022]).replace('\0','a')+"\"";store.write("bounded",maximum);assertEquals(maximum,store.read("bounded"));
   JsonCredentialSlots alternate=new JsonCredentialSlots(f.root,f.alias,slot->slot.equals("larger")?2048:1024);
   String larger="\""+new String(new char[1500]).replace('\0','b')+"\"";alternate.write("larger",larger);assertEquals(larger,alternate.read("larger"));
   try{store.read("larger");fail("Read limit ignored");}catch(IllegalArgumentException expected){}
   // Ciphertext framing allowance must not increase the plaintext byte limit.
   for(int bytes:new int[]{1025,1058}){
    String nearLimit="\""+new String(new char[bytes-2]).replace('\0','c')+"\"";
    alternate.write("larger",nearLimit);assertEquals(nearLimit,alternate.read("larger"));
    try{store.read("larger");fail("Near-boundary read limit ignored");}catch(IllegalArgumentException expected){}
    assertEquals(nearLimit,alternate.read("larger"));
   }
   try{store.slotFile("../escape");fail("Unsafe filename accepted");}catch(IllegalArgumentException expected){}
  }
 }
}
