package ai.eliza.plugins.agent.contract;
import ai.eliza.plugins.agent.health.NativeHealthEvidence;
import org.json.JSONObject;
public final class NativeHealthContract {
 public static void run()throws Exception {
  String nonce="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";JSONObject good=new JSONObject().put("schemaVersion",5).put("nonce",nonce).put("versionCode",1).put("distribution","standalone").put("observedElapsed",100).put("runtimeState","stopped").put("runtimeEpoch",0).put("processInstance","12345678-1234-4567-89ab-123456789abc").put("runtimeInstance","none").put("agentResponsive",false).put("gatewayResponsive",false).put("activityState","absent").put("rendererResponsive",false).put("contentPresent",false).put("diagnosticStorageResponsive",true).put("taskStorage","unavailable");
  NativeHealthEvidence.parse(good.toString(),nonce,1,90,110,120);
  for(Object[] change:new Object[][]{{"nonce","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},{"versionCode",2},{"observedElapsed",89},{"observedElapsed",111},{"runtimeEpoch",-1},{"schemaVersion","1"},{"schemaVersion",4294967301L},{"schemaVersion",4},{"taskStorage","ok"},{"taskStorage","unknown"},{"schemaVersion",3},{"diagnosticStorageResponsive","true"},{"schemaVersion",2},{"activityState","bogus"},{"contentPresent",true},{"rendererResponsive",true},{"schemaVersion",1},{"processInstance","bad"},{"runtimeInstance",1},{"runtimeState","running"},{"agentResponsive",true},{"gatewayResponsive","false"},{"distribution","other"},{"extra",true}}){JSONObject bad=new JSONObject(good.toString()).put((String)change[0],change[1]);try{NativeHealthEvidence.parse(bad.toString(),nonce,1,90,110,120);throw new AssertionError("Accepted "+change[0]);}catch(java.io.IOException expected){}}
  for(long now:new long[]{89,120})try{NativeHealthEvidence.parse(good.toString(),nonce,1,90,now,120);throw new AssertionError("Accepted stale time");}catch(java.io.IOException expected){}
 }
}
