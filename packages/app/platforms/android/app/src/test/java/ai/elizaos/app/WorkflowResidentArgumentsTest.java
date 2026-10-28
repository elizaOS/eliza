package ai.elizaos.app;
import org.junit.Test;import static org.junit.Assert.*;import java.io.IOException;import java.nio.charset.StandardCharsets;
public class WorkflowResidentArgumentsTest {
 private byte[] observe(byte[] bytes,WorkflowSurvivorInventory.ProcessPresence presence)throws Exception {
  return WorkflowSurvivorInventory.observePresent(42,()->WorkflowSurvivorInventory.residentArguments(bytes,"/bun","/loader","/bundle")?bytes:null,presence);
 }
 @Test public void incompleteArgvIsOmittedOnlyWhenGoneOrTerminal()throws Exception {assertNull(observe(new byte[0],pid->false));}
 @Test public void incompleteLiveArgvStillRefuses()throws Exception {assertThrows(IOException.class,()->observe(new byte[0],pid->true));}
 @Test public void uncertainPresenceDoesNotExcuseIncompleteArgv()throws Exception {assertThrows(IOException.class,()->observe(new byte[0],pid->{throw new IOException("unknown");}));}
 @Test public void exactResidentIsRetainedAndOtherProcessesAreNeverSelected()throws Exception {
  byte[] resident="/loader\0/bun\0--no-install\0/bundle\0android-bridge\0".getBytes(StandardCharsets.UTF_8);
  assertSame(resident,observe(resident,pid->{throw new AssertionError();}));
  assertNull(observe("/other\0".getBytes(StandardCharsets.UTF_8),pid->{throw new AssertionError();}));
 }
}
