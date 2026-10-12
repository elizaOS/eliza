package ai.eliza.host;

import ai.eliza.plugins.agent.runtime.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public final class VerifiedTaskCustodyInstrumentedTest {
  private static String record(String user, String credential) throws Exception {
    return new JSONObject().put("version",1).put("credential",credential).put("credentialId",credential)
        .put("owner",new JSONObject().put("authority","https://cloud.example").put("userId",user).put("organizationId","org")).toString();
  }
  private static final LocalCredentialBroker.Store UNUSED = new LocalCredentialBroker.Store() {
    public String read(){ return null; } public void write(String v){ throw new AssertionError(); } public void clear(){ throw new AssertionError(); }
  };
  private static final class Fixture implements AutoCloseable {
    final String id=UUID.randomUUID().toString(), accountAlias="synthetic-account-"+id,keyAlias="synthetic-task-"+id;
    final Path dir;
    final CompletableFuture<VerifiedTaskCustody> ready=new CompletableFuture<>();
    final NativeRuntimeSession session;
    final VerifiedTaskCustody custody;
    Fixture() throws Exception {
      dir=InstrumentationRegistry.getInstrumentation().getTargetContext().getNoBackupFilesDir().getCanonicalFile().toPath().resolve(id);
      Files.createDirectory(dir); android.system.Os.chmod(dir.toString(),0700);
      Path db=Files.createDirectory(dir.resolve("db")); android.system.Os.chmod(db.toString(),0700);
      session=new NativeRuntimeSession(scope->{try{scope.startReady("synthetic-child",new ProcessBuilder("/system/bin/sleep","120"),new NativeProcessLog(dir.resolve("child.log"),4096,256),Collections.emptyList(),()->true,3000,20);ready.complete(new VerifiedTaskCustody(scope,dir.resolve("account").toFile(),accountAlias,dir.resolve("keys").toFile(),keyAlias,db.toFile()));}catch(Throwable e){ready.completeExceptionally(e);throw e;}},100,100,0);
      session.start(); custody=ready.get(10,TimeUnit.SECONDS);
    }
    public void close() throws Exception {
      session.close(); KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
      store.deleteEntry(accountAlias);store.deleteEntry(keyAlias);
      try(java.util.stream.Stream<Path> paths=Files.walk(dir)){for(Path p:paths.sorted(Comparator.reverseOrder()).toArray(Path[]::new))Files.delete(p);}
    }
  }
  private interface Action {void run() throws Exception;}
  private static void refused(Action action) throws Exception {try{action.run();fail("Expected refusal");}catch(IOException expected){}}
  private static JSONObject request(LocalCredentialBroker broker,JSONObject body) throws Exception {
    HttpURLConnection c=(HttpURLConnection)new URL("http://127.0.0.1:"+broker.port()+"/credential").openConnection();
    c.setConnectTimeout(3000);c.setReadTimeout(3000);c.setRequestMethod("POST");c.setRequestProperty("Authorization","Bearer synthetic-private-test-token");c.setDoOutput(true);
    byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(bytes.length);
    try(OutputStream out=c.getOutputStream()){out.write(bytes);}
    int status=c.getResponseCode();try(InputStream in=status==200?c.getInputStream():c.getErrorStream()){
      JSONObject result=new JSONObject(new String(in.readAllBytes(),StandardCharsets.UTF_8));result.put("status",status);return result;
    }finally{c.disconnect();}
  }
  @Test public void tcpCreationRotationAndMissingKeyRefusal() throws Exception {
    try(Fixture f=new Fixture()) {
      String a=record("owner-a","synthetic-credential-one");assertTrue(f.custody.accountPort().compareExchange(null,a));
      VerifiedTaskCustody.Database db=f.custody.bindDatabase("tasks");
      try(LocalCredentialBroker broker=f.custody.openBroker(UNUSED,UNUSED,"synthetic-private-test-token",db)) {
        JSONObject created=request(broker,new JSONObject().put("operation","task-key-create"));assertEquals(200,created.getInt("status"));
        String key=created.getString("value");assertEquals(32,Base64.getDecoder().decode(new JSONObject(key).getString("key")).length);
        assertEquals(key,db.read());
        String rotated=record("owner-a","synthetic-credential-two");assertTrue(f.custody.accountPort().compareExchange(a,rotated));
        JSONObject retired=request(broker,new JSONObject().put("operation","task-key-read"));assertEquals(503,retired.getInt("status"));assertFalse(retired.toString().contains("synthetic-credential"));
        VerifiedTaskCustody.Database next=f.custody.bindDatabase("tasks");assertEquals(db.ownerIdentity,next.ownerIdentity);assertEquals(key,next.read());
        assertFalse(f.custody.accountPort().compareExchange(a,null));
        String other=record("owner-b","synthetic-credential-three");assertTrue(f.custody.accountPort().compareExchange(rotated,other));
        VerifiedTaskCustody.Database isolated=f.custody.bindDatabase("tasks");assertNotEquals(db.path,isolated.path);assertNull(isolated.read());
      }
    }
  }
  @Test public void existingFilesAndDanglingLinksNeverCreateKeys() throws Exception {
    try(Fixture f=new Fixture()) {
      assertTrue(f.custody.accountPort().compareExchange(null,record("owner","synthetic-credential-one")));
      int n=0;for(String suffix:new String[]{"","-wal","-shm","-journal"}) {
        VerifiedTaskCustody.Database db=f.custody.bindDatabase("tasks"+n++);Path existing=Path.of(db.path+suffix);Files.createFile(existing);
        refused(db::read);refused(db::createForNewDatabase);Files.delete(existing);assertNull(db.read());
      }
      VerifiedTaskCustody.Database db=f.custody.bindDatabase("symlink");Files.createSymbolicLink(db.path,Path.of("missing"));refused(db::read);refused(db::createForNewDatabase);
    }
  }
  @Test public void removalRequiresAbsentDatabaseAndExactGeneration() throws Exception {
    try(Fixture f=new Fixture()) {
      assertTrue(f.custody.accountPort().compareExchange(null,record("owner","synthetic-credential-one")));
      VerifiedTaskCustody.Database db=f.custody.bindDatabase("tasks");String id=new JSONObject(db.createForNewDatabase()).getString("id");
      assertFalse(db.remove(UUID.randomUUID().toString()));Files.createFile(db.path);refused(()->db.remove(id));Files.delete(db.path);
      assertTrue(db.remove(id));assertNull(db.read());
    }
  }
  @Test public void queuedOwnerChangeAndLifecycleRetireAccess() throws Exception {
    try(Fixture f=new Fixture()) {
      String first=record("owner","synthetic-credential-one");assertTrue(f.custody.accountPort().compareExchange(null,first));
      VerifiedTaskCustody.Database db=f.custody.bindDatabase("tasks");ExecutorService pool=Executors.newSingleThreadExecutor();
      try {
        Future<Boolean> request;CountDownLatch queued=new CountDownLatch(1);
        synchronized(f.custody.guard()) {
          request=pool.submit(()->{queued.countDown();try{db.createForNewDatabase();return false;}catch(IOException denied){return true;}});
          assertTrue(queued.await(3,TimeUnit.SECONDS));assertTrue(f.custody.accountPort().compareExchange(first,null));
        }
        assertTrue(request.get(3,TimeUnit.SECONDS));
        assertTrue(f.custody.accountPort().compareExchange(null,first));VerifiedTaskCustody.Database fresh=f.custody.bindDatabase("tasks");assertNull(fresh.read());
        try(LocalCredentialBroker broker=f.custody.openBroker(UNUSED,UNUSED,"synthetic-private-test-token",fresh)) {
          f.session.close();refused(fresh::read);refused(f.custody.accountPort()::read);
          refused(()->request(broker,new JSONObject().put("operation","task-key-read")));
        }
      }finally{pool.shutdownNow();}
    }
  }
  @Test public void directoryReplacementAndNonprivateRootRefuse() throws Exception {
    try(Fixture f=new Fixture()) {
      assertTrue(f.custody.accountPort().compareExchange(null,record("owner","synthetic-credential-one")));
      Path root=f.dir.resolve("db");
      android.system.Os.chmod(root.toString(),0755);
      try { refused(()->f.custody.bindDatabase("tasks")); }
      finally { android.system.Os.chmod(root.toString(),0700); }
      VerifiedTaskCustody.Database db=f.custody.bindDatabase("tasks");
      Path owner=db.path.getParent(), moved=root.resolve("moved");Files.move(owner,moved);
      Files.createSymbolicLink(owner,moved);
      try { refused(db::read);refused(db::createForNewDatabase); }
      finally {Files.delete(owner);Files.move(moved,owner);}
      assertNull(db.read());
    }
  }
  @Test public void identityMatchesJavascriptAndSeparatesTupleComponents() throws Exception {
    String base=record("slash/quote\"back\\雪😀","synthetic-credential-one");
    assertEquals("cloud-owner-v1:62daffc216635641024e10f1dc368706bc4398090e4331ff7f8413702ed64462",VerifiedTaskCustody.ownerIdentity(base));
    JSONObject changed=new JSONObject(base);changed.getJSONObject("owner").put("organizationId","other");assertNotEquals(VerifiedTaskCustody.ownerIdentity(base),VerifiedTaskCustody.ownerIdentity(changed.toString()));
  }
}
