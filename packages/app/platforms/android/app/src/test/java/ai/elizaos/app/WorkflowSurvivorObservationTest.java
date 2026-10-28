package ai.elizaos.app;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.IOException;
public class WorkflowSurvivorObservationTest {
 @Test public void successfulObservationIsRetained() throws Exception {
  Object value=new Object(); assertSame(value,WorkflowSurvivorInventory.observePresent(42,()->value,pid->{throw new AssertionError("unexpected presence check");}));
 }
 @Test public void vanishedOrProvenTerminalProcessIsOmitted() throws Exception {
  assertNull(WorkflowSurvivorInventory.observePresent(42,()->{throw new IOException("exe disappeared");},pid->false));
 }
 @Test public void liveProcessObservationFailureIsPreserved() throws Exception {
  IOException failure=new IOException("exe unavailable but process live");
  assertSame(failure,assertThrows(IOException.class,()->WorkflowSurvivorInventory.observePresent(42,()->{throw failure;},pid->true)));
 }
 @Test public void uncertainPresenceCannotExcuseObservationFailure() throws Exception {
  IOException failure=new IOException("readlink failed");
  assertSame(failure,assertThrows(IOException.class,()->WorkflowSurvivorInventory.observePresent(42,()->{throw failure;},pid->{throw new IOException("presence denied");})));
 }
 private String state(char state){return "42 (worker name) "+state+" 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 123";}
 @Test public void onlyTerminalStatesAllowTerminalIdentity() throws Exception {
  for(char state:new char[]{'Z','X','x'}) assertEquals("42:123",WorkflowSurvivorInventory.terminalStateKey(42,state(state)));
  for(char state:new char[]{'R','S','D','T'}) assertNull(WorkflowSurvivorInventory.terminalStateKey(42,state(state)));
  assertThrows(IOException.class,()->WorkflowSurvivorInventory.terminalStateKey(43,state('Z')));
  assertThrows(IOException.class,()->WorkflowSurvivorInventory.terminalStateKey(42,"malformed"));
 }
}
