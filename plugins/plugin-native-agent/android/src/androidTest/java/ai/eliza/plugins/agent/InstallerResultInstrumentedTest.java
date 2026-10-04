package ai.eliza.plugins.agent;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import ai.eliza.plugins.agent.contract.InstallerResultContract;
import ai.eliza.plugins.agent.runtime.AndroidRuntimeDirectories;
import ai.eliza.plugins.agent.updater.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.nio.file.*;
@RunWith(AndroidJUnit4.class)
public final class InstallerResultInstrumentedTest {
 @Test public void callbackHintsRequireActualSessionReadback()throws Exception {
  Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
  String target=app.getPackageName();UpdateJournal.Identity baseline=PackageInstallCoordinator.installed(app,target);
  Path root=Files.createTempDirectory(app.getNoBackupFilesDir().toPath(),"installer-contract-");
  try {
   UpdateJournal journal=new UpdateJournal(root,AndroidRuntimeDirectories::syncRuntimeDirectory);
   UpdateJournal.Plan plan=new UpdateJournal.Plan("callback-contract","stable","standalone",baseline,
    new UpdateJournal.Identity(baseline.code+1,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    new UpdateJournal.Identity(baseline.code+2,"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
   InstallerResultContract.run(app,journal,plan,target,target+".INSTALL_RESULT");
  } finally {try(java.util.stream.Stream<Path> files=Files.walk(root)){for(Path file:(Iterable<Path>)files.sorted(java.util.Comparator.reverseOrder())::iterator)Files.delete(file);}}
 }
}
