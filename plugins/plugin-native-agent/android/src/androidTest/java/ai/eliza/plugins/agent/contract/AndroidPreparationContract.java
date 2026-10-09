package ai.eliza.plugins.agent.contract;
import android.content.Context;
import android.content.ContextWrapper;
import ai.eliza.plugins.agent.updater.*;
import ai.eliza.plugins.agent.updater.NativePreparation.*;
import java.io.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import ai.eliza.plugins.agent.runtime.AndroidRuntimeDirectories;

/** Actual Android storage/lock boundary with deliberately non-authorizing trust ports. */
public final class AndroidPreparationContract {
 private interface Operation{void run()throws Exception;}
 private static void check(boolean ok){if(!ok)throw new AssertionError();}
 private static void rejects(Operation operation)throws Exception{try{operation.run();throw new AssertionError("Expected rejection");}catch(IOException expected){}}
 public static void run(Context context)throws Exception {
  Path root=Files.createTempDirectory(context.getNoBackupFilesDir().toPath(),"preparation-contract-");
  try {
   Context isolated=new ContextWrapper(context){@Override public File getNoBackupFilesDir(){return root.toFile();}};
   UpdateJournal journal=new UpdateJournal(root.resolve("journal"),AndroidRuntimeDirectories::syncRuntimeDirectory);int[] reads={0};
   Trust trust=new Trust(){
    public Enrollment readEnrollment(String directory){reads[0]++;check(directory.equals(root.resolve("ota-enrollment").toString()));return new Enrollment("{}".getBytes(StandardCharsets.UTF_8),new byte[]{1},"test-cohort");}
    public void prune(String directory,String retained){throw new AssertionError("Unexpected authority call");}
    public void verify(String directory,UpdateJournal.Plan plan,long generation,byte[] c,byte[] r){throw new AssertionError("Unexpected authority call");}
    public EnrolledDiscovery newEnrolledDiscoveryWithTimeSource(String directory,InputProvider time){throw new AssertionError("Unexpected discovery");}
    public PreparedStager newPreparedStagerWithTimeSource(String directory,InputProvider time){throw new AssertionError("Unexpected staging");}
    public CheckDecision beginStagingInterval(String directory,long l,long u,long g){throw new AssertionError("Unexpected scheduling");}
    public CheckDecision finishStagingInterval(String directory,String token,long l,long u,boolean success,long retry){throw new AssertionError("Unexpected scheduling");}
    public String evaluateRememberedReleaseInterval(String directory,byte[] d,byte[] device,byte[] policy){throw new AssertionError("Unexpected admission");}
   };
   InputProvider inputs=new InputProvider(){public Inputs read(){throw new AssertionError("Unexpected observation");}public QualifiedClockAnchor.Interval readTime(){throw new AssertionError("Unexpected clock");}};
   ArtifactVerifier verifier=(s,c,r,h,a,cf,rf,p,g)->{throw new AssertionError("Unexpected APK verification");};
   JobRunRegistry.Cancellation cancelled=new JobRunRegistry.Cancellation();cancelled.cancel();
   rejects(()->NativePreparation.run(isolated,journal,context.getPackageName(),"test.distribution",trust,verifier,inputs,cancelled));check(reads[0]==0);
   Path lock=root.resolve("ota-preparation.lock");
   try(FileChannel file=FileChannel.open(lock,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE);FileLock held=file.lock()) {
    check(NativePreparation.run(isolated,journal,context.getPackageName(),"test.distribution",trust,verifier,inputs,new JobRunRegistry.Cancellation())==PreparationFlow.Outcome.BUSY);
   }
   check(reads[0]==1);check(journal.read().phase==UpdateJournal.Phase.IDLE);
   Files.delete(lock);Files.createSymbolicLink(lock,root.resolve("other"));
   rejects(()->NativePreparation.run(isolated,journal,context.getPackageName(),"test.distribution",trust,verifier,inputs,new JobRunRegistry.Cancellation()));
   check(reads[0]==2);check(journal.read().phase==UpdateJournal.Phase.IDLE);
  } finally {try(var paths=Files.walk(root)){for(Path item:paths.sorted(java.util.Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList()))Files.delete(item);}}
 }
}
