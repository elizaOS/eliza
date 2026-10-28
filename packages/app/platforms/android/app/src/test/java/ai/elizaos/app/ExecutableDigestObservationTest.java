package ai.elizaos.app;

import java.io.File;
import java.io.IOException;
import org.junit.Test;
import static org.junit.Assert.*;

/** Cleanup of every admitted descriptor must survive another descriptor failing to close. */
public class ExecutableDigestObservationTest {
 private static final class ObservedFile implements WorkflowSurvivorInventory.DigestFile {
  int closes;
  final boolean failClose;
  ObservedFile(boolean failClose){this.failClose=failClose;}
  public String identity(){return "stable-fixture";}
  public String digest(long deadline){return "fixture-digest";}
  public void close()throws IOException{closes++;if(failClose)throw new IOException("fixture close");}
 }
 @Test public void closeFailureStillClosesAllObservedDescriptors()throws Exception {
  ObservedFile first=new ObservedFile(true),second=new ObservedFile(false);
  var observation=new WorkflowSurvivorInventory.ExecutableDigests(path->path.getName().equals("bun")?first:second);
  observation.digest(new File("/fixture/bun"),Long.MAX_VALUE,false);
  observation.digest(new File("/fixture/loader"),Long.MAX_VALUE,false);
  assertThrows(IOException.class,observation::close);
  assertEquals(1,first.closes);assertEquals(1,second.closes);
  observation.close();
  assertEquals(1,first.closes);assertEquals(1,second.closes);
 }
}
