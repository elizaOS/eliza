package ai.eliza.plugins.agent.health.contract;
import ai.eliza.plugins.agent.health.NativeStorageDiagnostic;
import android.content.Context;
import android.os.SystemClock;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;
public final class NativeStorageDiagnosticContract {
 public static void run(Context app,String namespace)throws Exception{
  File directory=new File(app.getNoBackupFilesDir(),namespace);
  for(String bad:new String[]{"..","../escape","x/y",""})try{NativeStorageDiagnostic.check(app,bad,SystemClock.elapsedRealtime()+5000,1024*1024,16);fail("Invalid namespace accepted");}catch(IllegalArgumentException expected){}
  try{NativeStorageDiagnostic.check(app,namespace,SystemClock.elapsedRealtime()+5000,0,16);fail("Invalid byte budget accepted");}catch(IllegalArgumentException expected){}
  try{NativeStorageDiagnostic.check(app,namespace,SystemClock.elapsedRealtime()+5000,1024*1024,0);fail("Invalid entry budget accepted");}catch(IllegalArgumentException expected){}

  check(app,namespace,SystemClock.elapsedRealtime()+5000);
  assertEquals(Arrays.asList("lock"),Arrays.asList(directory.list()));
  try{NativeStorageDiagnostic.check(app,namespace,SystemClock.elapsedRealtime()+5000,1,16);fail("Database byte budget ignored");}catch(java.io.IOException expected){}
  assertEquals(Arrays.asList("lock"),Arrays.asList(directory.list()));
  File orphan=new File(directory,"probe-"+"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"+".db");Files.write(orphan.toPath(),new byte[]{1,2,3});
  try{NativeStorageDiagnostic.check(app,namespace,SystemClock.elapsedRealtime()+5000,1024*1024,1);fail("Cleanup entry budget ignored");}catch(java.io.IOException expected){}
  assertTrue(orphan.exists());
  check(app,namespace,SystemClock.elapsedRealtime()+5000);assertFalse(orphan.exists());
  File outside=new File(app.getNoBackupFilesDir(),namespace+"-sentinel");byte[] value={8,6,7,5,3,0,9};Files.write(outside.toPath(),value);
  android.system.Os.symlink(outside.getPath(),orphan.getPath());
  try{check(app,namespace,SystemClock.elapsedRealtime()+5000);fail("Symlink accepted");}catch(java.io.IOException expected){}finally{assertTrue(orphan.delete());}
  assertArrayEquals(value,Files.readAllBytes(outside.toPath()));
  boolean linked=false;
  try{android.system.Os.link(outside.getPath(),orphan.getPath());linked=true;}catch(android.system.ErrnoException policy){if(policy.errno!=android.system.OsConstants.EACCES&&policy.errno!=android.system.OsConstants.EPERM)throw policy;System.out.println("Hard-link construction denied by Android policy; link-count guard not exercised");}
  if(linked){try{check(app,namespace,SystemClock.elapsedRealtime()+5000);fail("Hard link accepted");}catch(java.io.IOException expected){}finally{assertTrue(orphan.delete());}}
  else assertFalse(orphan.exists());
  File lock=new File(directory,"lock");assertTrue(lock.delete());android.system.Os.symlink(outside.getPath(),lock.getPath());
  try{check(app,namespace,SystemClock.elapsedRealtime()+5000);fail("Unsafe lock accepted");}catch(java.io.IOException expected){}finally{assertTrue(lock.delete());}
  assertArrayEquals(value,Files.readAllBytes(outside.toPath()));
  File unknown=new File(directory,"not-a-diagnostic");Files.write(unknown.toPath(),value);
  try{check(app,namespace,SystemClock.elapsedRealtime()+5000);fail("Unknown file deleted");}catch(java.io.IOException expected){}finally{assertArrayEquals(value,Files.readAllBytes(unknown.toPath()));assertTrue(unknown.delete());assertTrue(outside.delete());}
  try{check(app,namespace,SystemClock.elapsedRealtime()-1);fail("Expired probe accepted");}catch(java.io.IOException expected){}
  check(app,namespace,SystemClock.elapsedRealtime()+5000);assertEquals(Arrays.asList("lock"),Arrays.asList(directory.list()));
 }

 private static void check(Context app,String namespace,long deadline)throws Exception{NativeStorageDiagnostic.check(app,namespace,deadline,1024*1024,16);}
 private static void assertTrue(boolean value){if(!value)throw new AssertionError("Expected true");}
 private static void assertFalse(boolean value){if(value)throw new AssertionError("Expected false");}
 private static void assertEquals(Object expected,Object actual){if(!java.util.Objects.equals(expected,actual))throw new AssertionError("Values differ");}
 private static void assertArrayEquals(byte[] expected,byte[] actual){if(!Arrays.equals(expected,actual))throw new AssertionError("Bytes differ");}
 private static void fail(String message){throw new AssertionError(message);}
}
