package ai.eliza.plugins.agent.runtime;
import static org.junit.Assert.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import org.junit.Test;

public final class RuntimePrivateFilesInstrumentedTest {
 @Test public void privateAtomicPublicationAndBoundedRead()throws Exception {
  Path root=Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir().toPath(),"private-files-");
  Path file=root.resolve("config"), link=root.resolve("link");
  try {
   RuntimePrivateFiles.write(file,"first".getBytes(StandardCharsets.UTF_8),AndroidRuntimeDirectories::syncRuntimeDirectory);
   assertEquals(0600,android.system.Os.stat(file.toString()).st_mode & 0777);
   RuntimePrivateFiles.write(file,"second".getBytes(StandardCharsets.UTF_8),AndroidRuntimeDirectories::syncRuntimeDirectory);
   assertEquals("second",RuntimePrivateFiles.readOptionalSingleLine(file,1,32));
   try {RuntimePrivateFiles.readOptionalSingleLine(file,1,3);fail("Oversized input accepted");}catch(IOException expected){}
   Files.createSymbolicLink(link,file);
   try {RuntimePrivateFiles.write(link,new byte[]{1},AndroidRuntimeDirectories::syncRuntimeDirectory);fail("Link accepted");}catch(IOException expected){}
   assertEquals("second",RuntimePrivateFiles.readOptionalSingleLine(file,1,32));
   try(var children=Files.list(root)){assertEquals(2,children.count());}
  }finally{Files.deleteIfExists(link);Files.deleteIfExists(file);Files.deleteIfExists(root);}
 }
}
