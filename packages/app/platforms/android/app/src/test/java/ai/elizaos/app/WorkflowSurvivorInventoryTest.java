package ai.elizaos.app;
import java.util.*;
import java.io.IOException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public class WorkflowSurvivorInventoryTest {
 private WorkflowSurvivorInventory.Identity identity(int pid,String start){return new WorkflowSurvivorInventory.Identity(pid,2710149,start,"/apk/loader","1","2","abc");}
 private JSONObject owner()throws Exception{return new JSONObject().put("schemaVersion",2).put("uid",2710149).put("pid",42).put("executable","/apk/loader").put("nativeIdentity",new JSONObject().put("pid",42).put("uid",2710149).put("startTicks","123").put("executable","/apk/loader").put("device","1").put("inode","2").put("sha256","abc"));}
 private void verify(JSONObject owner,int uid,int pid)throws Exception{WorkflowSurvivorInventory.verifyBinding(owner,identity(42,"123"),uid,pid,"/apk/bun","/apk/loader","abc");}
 @Test public void mappedBunRequiresExactKernelFileAndExecutableSegment()throws Exception {
  String maps="1000-2000 r--p 00000000 fe:2b 99 /apk/bun\n2000-3000 r-xp 00001000 fe:2b 99 /apk/bun\n3000-4000 rw-p 00002000 fe:2b 99 /apk/bun\n4000-5000 rw-p 00000000 00:00 0 [heap]\n";
  assertTrue(WorkflowSurvivorInventory.verifyMappedBunText(maps,"/apk/bun",65067,99).contains("r-xp"));
  for(String invalid:new String[]{maps.replace("fe:2b","fe:2c"),maps.replace(" 99 "," 100 "),maps.replace("/apk/bun","/apk/other"),maps.replace("/apk/bun","/apk/bun (deleted)"),maps.replace("r-xp","r--p"),maps.replace("r-xp","rwxp"),maps.replace("2000-3000","3000-2000"),maps.substring(0,maps.length()-1),"malformed\n"})
   assertThrows(Exception.class,()->WorkflowSurvivorInventory.verifyMappedBunText(invalid,"/apk/bun",65067,99));
  assertThrows(Exception.class,()->WorkflowSurvivorInventory.verifyMappedBunText("x".repeat(4*1024*1024+1),"/apk/bun",65067,99));
 }
 @Test public void bunSelfReportCannotReplaceVerifiedLoader()throws Exception {
  assertThrows(IOException.class,()->verify(owner().put("executable","/apk/bun"),2710149,42));
 }
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
