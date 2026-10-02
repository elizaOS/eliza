package ai.elizaos.app;
import java.util.*;
import java.io.IOException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public class WorkflowSurvivorInventoryTest {
 private WorkflowSurvivorInventory.Identity identity(int pid,String start){return new WorkflowSurvivorInventory.Identity(pid,2710149,start,"/apk/loader","1","2","abc");}
 private JSONObject owner()throws Exception{return new JSONObject().put("schemaVersion",2).put("uid",2710149).put("pid",42).put("executable","/apk/bun").put("nativeIdentity",new JSONObject().put("pid",42).put("uid",2710149).put("startTicks","123").put("executable","/apk/loader").put("device","1").put("inode","2").put("sha256","abc"));}
 private void verify(JSONObject owner,int uid,int pid)throws Exception{WorkflowSurvivorInventory.verifyBinding(owner,identity(42,"123"),uid,pid,"/apk/bun","/apk/loader","abc");}
 @Test public void exactPeerAndGenerationIdentityAccepted()throws Exception{verify(owner(),2710149,42);}
 @Test public void uidPidReuseAndExecutableDifferencesRefused()throws Exception{
  assertThrows(IOException.class,()->verify(owner(),10149,42));assertThrows(IOException.class,()->verify(owner(),2710149,43));
  for(String field:new String[]{"startTicks","executable","device","inode","sha256"}) {JSONObject owner=owner();owner.getJSONObject("nativeIdentity").put(field,"changed");assertThrows(IOException.class,()->verify(owner,2710149,42));}
  assertThrows(IOException.class,()->verify(owner().put("schemaVersion",1),2710149,42));
 }
 @Test public void completeInventoryAllowsOnlyExactRegisteredSurvivors()throws Exception{
  Map<Integer,WorkflowSurvivorInventory.Identity> before=new HashMap<>();before.put(1,identity(1,"10"));before.put(42,identity(42,"123"));
  WorkflowSurvivorInventory.verifyInventory(before,new HashMap<>(before),Set.of(42),1);
  assertThrows(IOException.class,()->WorkflowSurvivorInventory.verifyInventory(before,before,Set.of(),1));
  Map<Integer,WorkflowSurvivorInventory.Identity> added=new HashMap<>(before);added.put(43,identity(43,"124"));assertThrows(IOException.class,()->WorkflowSurvivorInventory.verifyInventory(before,added,Set.of(42,43),1));
  Map<Integer,WorkflowSurvivorInventory.Identity> reused=new HashMap<>(before);reused.put(42,identity(42,"124"));assertThrows(IOException.class,()->WorkflowSurvivorInventory.verifyInventory(before,reused,Set.of(42),1));
 }
 @Test public void incompleteAndStaleJournalsDoNotVetoProvenWorker()throws Exception {
  Map<Integer,WorkflowSurvivorInventory.Identity> processes=Map.of(1,identity(1,"10"),42,identity(42,"123"));
  JSONObject stale=owner();stale.getJSONObject("nativeIdentity").put("startTicks","122");
  List<JSONObject> candidates=Arrays.asList(null,new JSONObject(),owner().put("schemaVersion",1),owner().put("pid",999),stale,owner());
  Set<Integer> verified=WorkflowSurvivorInventory.classifyCandidates(processes,candidates,1,(journal,observed)->verify(journal,observed.uid,observed.pid));
  assertEquals(Set.of(42),verified);
  assertThrows(IOException.class,()->WorkflowSurvivorInventory.classifyCandidates(processes,Arrays.asList(null,new JSONObject(),stale),1,(journal,observed)->verify(journal,observed.uid,observed.pid)));
 }
 @Test public void duplicateAuthenticatedOwnersAndUnknownProcessRefused()throws Exception {
  Map<Integer,WorkflowSurvivorInventory.Identity> processes=Map.of(1,identity(1,"10"),42,identity(42,"123"));
  assertThrows(IOException.class,()->WorkflowSurvivorInventory.classifyCandidates(processes,List.of(owner(),owner()),1,(journal,observed)->verify(journal,observed.uid,observed.pid)));
  Map<Integer,WorkflowSurvivorInventory.Identity> unknown=new HashMap<>(processes);unknown.put(43,identity(43,"200"));
  assertThrows(IOException.class,()->WorkflowSurvivorInventory.classifyCandidates(unknown,List.of(owner()),1,(journal,observed)->verify(journal,observed.uid,observed.pid)));
 }
}
