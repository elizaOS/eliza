package ai.eliza.plugins.agent.contract;
import android.content.Context;
import android.os.SystemClock;
import ai.eliza.plugins.agent.updater.AndroidQualifiedClock;
import ai.eliza.plugins.agent.updater.AndroidUpdateStorage;
import ai.eliza.plugins.agent.updater.QualifiedClockAnchor;
import java.io.*;
import java.nio.file.*;

/** Real Android filesystem, boot identity and elapsed-time contract. No clock authority is provisioned. */
public final class AndroidUpdateStorageContract {
 private interface Operation {void run()throws Exception;}
 private static void check(boolean ok){if(!ok)throw new AssertionError();}
 private static void rejects(Operation operation)throws Exception{try{operation.run();throw new AssertionError("Expected rejection");}catch(IOException expected){}}
 public static void run(Context context)throws Exception {
  Path root=Files.createTempDirectory(context.getNoBackupFilesDir().toPath(),"clock-contract-");
  try {
   AndroidUpdateStorage.sync(root);
   Path file=root.resolve("file");Files.write(file,new byte[]{1});rejects(()->AndroidUpdateStorage.sync(file));
   Path link=root.resolve("link");Files.createSymbolicLink(link,root);rejects(()->AndroidUpdateStorage.sync(link));
   Path state=root.resolve("clock");QualifiedClockAnchor.Policy policy=new QualifiedClockAnchor.Policy("test-qualified",60000,10000,0,0);
   rejects(()->new AndroidQualifiedClock(context,state,policy));
   AndroidQualifiedClock.initializeForProvisioning(state);
   AndroidQualifiedClock clock=new AndroidQualifiedClock(context,state,policy);rejects(clock::readInterval);
   long elapsed=SystemClock.elapsedRealtime();
   rejects(()->clock.acceptAuthenticated("another-boot","a".repeat(64),elapsed,1000000,1000100));
   clock.acceptAuthenticated(clock.bootIdentity(),"a".repeat(64),elapsed,1000000,1000100);
   QualifiedClockAnchor.Interval first=clock.readInterval();check(first.lower>=1000000&&first.upper>=first.lower);
   AndroidQualifiedClock restarted=new AndroidQualifiedClock(context,state,policy);
   check(restarted.bootIdentity().equals(clock.bootIdentity()));check(restarted.readInterval().lower>=first.lower);
   rejects(()->AndroidQualifiedClock.initializeForProvisioning(state));
  } finally {
   try(java.util.stream.Stream<Path> paths=Files.walk(root)){for(Path item:paths.sorted(java.util.Comparator.reverseOrder()).toList())Files.delete(item);}
  }
 }
}
