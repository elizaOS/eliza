package ai.eliza.plugins.agent.updater;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.lang.reflect.InvocationTargetException;
public final class RuntimeUpdatePauseTest {
 static int checks;
 static void check(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
 static final String A="a".repeat(64), B="b".repeat(64), C="c".repeat(64);
 static RuntimeUpdatePause.Record record(String id,int session){return new RuntimeUpdatePause.Record(id,session,9,10,A,11,B,C,false);}
 public static void main(String[] args)throws Exception {
  Path dir=Files.createTempDirectory("runtime-update-pause");
  RuntimeUpdatePause store=new RuntimeUpdatePause(dir);
  check(store.read()==null);
  RuntimeUpdatePause.configureStartAdmission(()->{try{return new RuntimeUpdatePause(dir).read()==null;}catch(Exception failed){return false;}});
  RuntimeUpdatePause.beforeStart();
  var first=record("00000000-0000-4000-8000-000000000001",3);
  store.acquire(first);check(store.read().id.equals(first.id));
  boolean blocked=false;try{RuntimeUpdatePause.beforeStart();}catch(IllegalStateException expected){blocked=true;}check(blocked);
  // Reopen the actual journal as a new host would after process death.
  store=new RuntimeUpdatePause(dir);check(store.read().session==3);
  check(!store.reconcile(first.id,10,A,10,A,RuntimeUpdatePause.Session.PENDING,false));
  check(!store.reconcile(first.id,10,A,10,A,RuntimeUpdatePause.Session.ABSENT,true));
  // A known pre-commit cancellation can release, but a stale callback cannot.
  check(!store.reconcile("00000000-0000-4000-8000-000000000002",10,A,10,A,RuntimeUpdatePause.Session.ABSENT,false));
  check(store.reconcile(first.id,10,A,10,A,RuntimeUpdatePause.Session.ABSENT,false));check(store.read()==null);
  store.acquire(first);store.committing(first.id);check(store.read().committing);
  store=new RuntimeUpdatePause(dir);
  // Dismissal/timeouts are unknown; no elapsed-time argument can clear them.
  check(!store.reconcile(first.id,10,A,10,A,RuntimeUpdatePause.Session.PENDING,false));
  check(!store.reconcile(first.id,11,B,10,A,RuntimeUpdatePause.Session.ABSENT,false));
  check(!store.reconcile(first.id,11,C,11,C,RuntimeUpdatePause.Session.ABSENT,false));
  // Exact successor must be both installed and the currently executing binary.
  check(store.reconcile(first.id,11,B,11,B,RuntimeUpdatePause.Session.PENDING,false));
  var second=record("00000000-0000-4000-8000-000000000002",4);store.acquire(second);
  check(!store.reconcile(first.id,10,A,10,A,RuntimeUpdatePause.Session.ABSENT,false));
  check(store.reconcile(second.id,10,A,10,A,RuntimeUpdatePause.Session.PROVEN_UNCOMMITTED,false));
  store.acquire(second);store.committing(second.id);
  check(store.reconcile(second.id,10,A,10,A,RuntimeUpdatePause.Session.ABSENT,false));
  store.acquire(second);Files.writeString(dir.resolve("pause"),"corrupt");
  boolean refused=false;try{store.read();}catch(java.io.IOException expected){refused=true;}check(refused);
  blocked=false;try{RuntimeUpdatePause.beforeStart();}catch(IllegalStateException expected){blocked=true;}check(blocked);
  deniedLookup(dir.resolve("lookup-denied"));
  System.out.println("RuntimeUpdatePause: "+checks+" assertions passed");
 }
 static void deniedLookup(Path directory)throws Exception {
  if(!Files.getFileStore(directory.getParent()).supportsFileAttributeView("posix")){
   System.out.println("RuntimeUpdatePause: denied lookup skipped; POSIX permissions unavailable");return;
  }
  RuntimeUpdatePause store=new RuntimeUpdatePause(directory);
  store.acquire(record("00000000-0000-4000-8000-000000000003",5));
  var permissions=Files.getPosixFilePermissions(directory);
  try{
   // Deny directory search so the existing journal cannot be inspected, not merely read.
   Files.setPosixFilePermissions(directory,java.util.Set.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE));
   boolean denied=false;
   try{Files.readAttributes(directory.resolve("pause"),BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);}
   catch(AccessDeniedException expected){denied=true;}
   if(!denied){System.out.println("RuntimeUpdatePause: denied lookup skipped; host bypasses permissions");return;}
   // Isolate the lookup itself: public read() would first fail opening the sibling lock.
   var load=RuntimeUpdatePause.class.getDeclaredMethod("load");load.setAccessible(true);
   boolean refused=false;
   try{load.invoke(store);}catch(InvocationTargetException failure){if(failure.getCause() instanceof AccessDeniedException)refused=true;else throw failure;}
   check(refused);
   refused=false;try{store.read();}catch(AccessDeniedException expected){refused=true;}check(refused);
   RuntimeUpdatePause.configureStartAdmission(()->{try{return store.read()==null;}catch(Exception unavailable){return false;}});
   boolean blocked=false;try{RuntimeUpdatePause.beforeStart();}catch(IllegalStateException expected){blocked=true;}check(blocked);
   System.out.println("RuntimeUpdatePause: denied metadata lookup and startup refusal passed");
  }finally{Files.setPosixFilePermissions(directory,permissions);}
  check(store.read()!=null);
 }
}
