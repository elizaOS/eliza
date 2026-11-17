package ai.eliza.plugins.agent.health;
import java.io.IOException;import java.util.*;import org.json.JSONObject;
/** Wire validation only. Signature/UID, installed digest and distribution are
 * independently checked by the client around the request. No healthy verdict. */
public final class NativeHealthEvidence {
 public static JSONObject parse(String body,String nonce,long version,long started,long now,long deadline)throws Exception {
  if(body==null||body.length()>4096)throw new IOException("Health response budget");
  JSONObject value=new JSONObject(body);Set<String> keys=new HashSet<>();value.keys().forEachRemaining(keys::add);
  if(!keys.equals(new HashSet<>(Arrays.asList("schemaVersion","nonce","versionCode","distribution","observedElapsed","runtimeState","runtimeEpoch","processInstance","runtimeInstance","agentResponsive","gatewayResponsive","activityState","rendererResponsive","contentPresent","diagnosticStorageResponsive","taskStorage"))))throw new IOException("Health response fields");
  for(String name:new String[]{"schemaVersion","versionCode","observedElapsed","runtimeEpoch"}){Object n=value.get(name);if(!(n instanceof Integer||n instanceof Long)||((Number)n).longValue()<0)throw new IOException("Health numeric type");}
  if(value.getLong("schemaVersion")!=5||!nonce.equals(value.get("nonce"))||value.getLong("versionCode")!=version)throw new IOException("Health subject mismatch");
  long observed=value.getLong("observedElapsed");
  if(started<0||deadline<=started||now<started||now>=deadline||observed<started||observed>now)throw new IOException("Stale health observation");
  if(!Arrays.asList("launcher","standalone").contains(value.get("distribution"))||!Arrays.asList("stopped","starting","running","failed").contains(value.get("runtimeState")))throw new IOException("Invalid native state");
  String uuid="[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
  Object process=value.get("processInstance"),runtime=value.get("runtimeInstance");
  if(!(process instanceof String)||!((String)process).matches(uuid)||!(runtime instanceof String)||!("none".equals(runtime)||((String)runtime).matches(uuid)))throw new IOException("Invalid process lifetime");
  if("none".equals(runtime)&&(!"stopped".equals(value.getString("runtimeState"))||value.getLong("runtimeEpoch")!=0))throw new IOException("Missing runtime lifetime");
  if(!(value.get("agentResponsive") instanceof Boolean)||!(value.get("gatewayResponsive") instanceof Boolean))throw new IOException("Invalid native observations");
  if(!"running".equals(value.getString("runtimeState"))&&(value.getBoolean("agentResponsive")||value.getBoolean("gatewayResponsive")))throw new IOException("Inconsistent native state");
  if(!Arrays.asList("absent","background","foreground").contains(value.get("activityState"))||!(value.get("rendererResponsive") instanceof Boolean)||!(value.get("contentPresent") instanceof Boolean))throw new IOException("Invalid UI observation");
  if(!"foreground".equals(value.get("activityState"))&&(value.getBoolean("rendererResponsive")||value.getBoolean("contentPresent")))throw new IOException("Inconsistent UI observation");
  if(value.getBoolean("contentPresent")&&!value.getBoolean("rendererResponsive"))throw new IOException("Content without renderer response");
  if(!(value.get("diagnosticStorageResponsive") instanceof Boolean))throw new IOException("Invalid diagnostic observation");
  if(!Arrays.asList("ok","unavailable","deferred").contains(value.get("taskStorage")))throw new IOException("Invalid task storage observation");
  if(!"unavailable".equals(value.get("taskStorage"))&&(!"running".equals(value.get("runtimeState"))||!value.getBoolean("gatewayResponsive")))throw new IOException("Inconsistent task storage observation");
  return value;
 }
}
