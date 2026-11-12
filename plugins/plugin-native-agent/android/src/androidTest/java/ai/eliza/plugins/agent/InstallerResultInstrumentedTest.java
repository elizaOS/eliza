package ai.eliza.plugins.agent;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import ai.eliza.plugins.agent.contract.InstallerResultContract;
import ai.eliza.plugins.agent.runtime.AndroidRuntimeDirectories;
import ai.eliza.plugins.agent.updater.*;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.nio.file.*;
@RunWith(AndroidJUnit4.class)
public final class InstallerResultInstrumentedTest {
 interface Contract{void run(Context app,UpdateJournal journal,UpdateJournal.Plan plan,String target)throws Exception;}
 @Test public void callbackHintsRequireActualSessionReadback()throws Exception {
  withJournal((app,journal,plan,target)->InstallerResultContract.run(app,journal,plan,target,target+".INSTALL_RESULT"));
 }
 @Test public void uncommittedSessionIsAbandonedAndReleased()throws Exception {
  // Before API 29 the platform cannot report a session uncommitted.
  Assume.assumeTrue(android.os.Build.VERSION.SDK_INT>=29);
  withJournal(InstallerResultContract::runUncommittedSession);
 }
 private static void withJournal(Contract contract)throws Exception {
  Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
  String target=app.getPackageName();UpdateJournal.Identity baseline=PackageInstallCoordinator.installed(app,target);
  Path root=Files.createTempDirectory(app.getNoBackupFilesDir().toPath(),"installer-contract-");
  try {
   UpdateJournal journal=new UpdateJournal(root,AndroidRuntimeDirectories::syncRuntimeDirectory);
   UpdateJournal.Plan plan=new UpdateJournal.Plan("callback-contract","stable","standalone",baseline,
    new UpdateJournal.Identity(baseline.code+1,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    new UpdateJournal.Identity(baseline.code+2,"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
   contract.run(app,journal,plan,target);
  } finally {try(java.util.stream.Stream<Path> files=Files.walk(root)){for(Path file:(Iterable<Path>)files.sorted(java.util.Comparator.reverseOrder())::iterator)Files.delete(file);}}
 }
}
