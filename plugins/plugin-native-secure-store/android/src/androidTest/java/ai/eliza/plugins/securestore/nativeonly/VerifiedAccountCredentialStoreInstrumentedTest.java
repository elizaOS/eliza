package ai.eliza.plugins.securestore.nativeonly;

import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.UUID;
import java.util.concurrent.*;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Synthetic identities only. Atomic encrypted record behavior, not an authenticated Cloud deployment. */
public final class VerifiedAccountCredentialStoreInstrumentedTest {
  private static final VerifiedAccountCredentialStore.Guard LIVE = () -> {};
  private static String record(String owner, String credential) throws Exception {
    return new JSONObject().put("version",1).put("credential",credential)
        .put("credentialId",UUID.randomUUID().toString()).put("owner",new JSONObject()
        .put("authority","https://api.example.test").put("userId",owner).put("organizationId","synthetic-org")).toString();
  }
  private static final class Fixture implements AutoCloseable {
    final File root=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getNoBackupFilesDir(),"verified-owner-"+UUID.randomUUID());
    final String alias="eliza.verified-owner-test."+UUID.randomUUID();
    final Object lock=new Object(); final KeyStore keys=KeyStore.getInstance("AndroidKeyStore");
    Fixture()throws Exception{assertTrue(root.mkdirs());keys.load(null);}
    VerifiedAccountCredentialStore store(){return new VerifiedAccountCredentialStore(root,alias,lock);}
    File file()throws Exception{JsonCredentialSlots s=new JsonCredentialSlots(root,alias,slot->8192);return s.slotFile(s.slotHash("verified-account-credential:v1")).getBaseFile();}
    @Override public void close()throws Exception{for(File f:root.listFiles())assertTrue(f.delete());assertTrue(root.delete());keys.deleteEntry(alias);}
  }
  @Test public void wholeRecordSurvivesRestartAndStaleCleanupCannotDeleteReplacement()throws Exception{
    try(Fixture f=new Fixture()){
      String a=record("owner-a","synthetic-credential-owner-a"),b=record("owner-b","synthetic-credential-owner-b");
      assertNull(f.store().read(LIVE));assertTrue(f.store().compareExchange(null,a,LIVE));assertEquals(a,f.store().read(LIVE));
      assertTrue(f.store().compareExchange(a,b,LIVE));assertFalse(f.store().compareExchange(a,null,LIVE));assertEquals(b,f.store().read(LIVE));
      byte[] encrypted=Files.readAllBytes(f.file().toPath());
      assertFalse(new String(encrypted,java.nio.charset.StandardCharsets.ISO_8859_1).contains("synthetic-credential"));
      assertNull(f.keys.getKey(f.alias,null).getEncoded());
      Files.move(f.file().toPath(),new File(f.file()+".bak").toPath());assertEquals(b,f.store().read(LIVE));
      assertTrue(f.store().compareExchange(b,null,LIVE));assertNull(f.store().read(LIVE));
    }
  }
  @Test public void malformedOrCorruptRecordIsNeverSilentlyReplaced()throws Exception{
    try(Fixture f=new Fixture()){
      String a=record("owner-a","synthetic-credential-owner-a");assertTrue(f.store().compareExchange(null,a,LIVE));
      JSONObject emptyOwner=new JSONObject(a);emptyOwner.getJSONObject("owner").put("userId", "");
      JSONObject pathAuthority=new JSONObject(a);pathAuthority.getJSONObject("owner").put("authority", "https://api.example.test/untrusted/path");
      for(String invalid:new String[]{"{}",emptyOwner.toString(),pathAuthority.toString()}){
        try{f.store().compareExchange(a,invalid,LIVE);fail("Invalid owner accepted");}catch(Exception expected){}
        assertEquals(a,f.store().read(LIVE));
      }
      byte[] corrupt=Files.readAllBytes(f.file().toPath());corrupt[corrupt.length-1]^=1;Files.write(f.file().toPath(),corrupt);
      try{f.store().compareExchange(null,a,LIVE);fail("Corrupt custody replaced");}catch(javax.crypto.AEADBadTagException expected){}
      assertArrayEquals(corrupt,Files.readAllBytes(f.file().toPath()));
    }
  }
  @Test public void waitingForStorageRechecksRetiredOwnerBeforeWrite()throws Exception{
    try(Fixture f=new Fixture()){
      String a=record("owner-a","synthetic-credential-owner-a");boolean[] live={true};
      VerifiedAccountCredentialStore.Guard guard=()->{if(!live[0])throw new IllegalStateException("Synthetic retired owner");};
      FutureTask<Boolean> request=new FutureTask<>(()->f.store().compareExchange(null,a,guard));
      Thread writer=new Thread(request,"SyntheticOwnerWriter");
      synchronized(JsonCredentialSlots.LOCK){
        writer.start();long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(writer.getState()!=Thread.State.BLOCKED && System.nanoTime()<deadline)Thread.sleep(5);
        assertEquals(Thread.State.BLOCKED,writer.getState());live[0]=false;
      }
      try{request.get(5,TimeUnit.SECONDS);fail("Retired write committed");}catch(ExecutionException expected){assertTrue(expected.getCause() instanceof IllegalStateException);}
      assertNull(f.store().read(LIVE));
    }
  }
  @Test public void competingSnapshotsAdmitOnlyOneWholeOwnerRecord()throws Exception{
    try(Fixture f=new Fixture()){
      ExecutorService pool=Executors.newFixedThreadPool(2);
      try{
        String a=record("owner-a","synthetic-credential-owner-a"),b=record("owner-b","synthetic-credential-owner-b");
        CountDownLatch start=new CountDownLatch(1);
        Future<Boolean> first=pool.submit(()->{start.await();return f.store().compareExchange(null,a,LIVE);});
        Future<Boolean> second=pool.submit(()->{start.await();return f.store().compareExchange(null,b,LIVE);});
        start.countDown();boolean won=first.get(10,TimeUnit.SECONDS);assertNotEquals(won,second.get(10,TimeUnit.SECONDS));assertEquals(won?a:b,f.store().read(LIVE));
      }finally{pool.shutdownNow();assertTrue(pool.awaitTermination(10,TimeUnit.SECONDS));}
    }
  }
}
