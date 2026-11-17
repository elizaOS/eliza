package ai.eliza.plugins.notifications;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/** Promotes an admitted action-journal attempt of a workflow notification step only from its original
 * durable notice receipt. Nothing is posted again; an uncertain receipt leaves the entry unchanged. */
public final class NoticeRecovery {
 public interface Receipt {String read(String id,String binding,String title,String body)throws Exception;}
 private NoticeRecovery(){}
 /** The receipt binding of one journal entry: scope, owner session, enrollment, proposal, digest and operation. */
 public static String binding(JSONObject entry,String scope,String proposalId)throws Exception{
  JSONObject record=entry.getJSONObject("record");
  JSONArray parts=new JSONArray().put(scope).put(record.getString("ownerId")).put(record.getString("agentId")).put(record.getString("sessionId")).put(record.getString("origin")).put(record.getString("installationId")).put(record.getString("enrollmentId")).put(proposalId).put(record.getString("digest")).put(entry.getString("operationId"));
  StringBuilder hash=new StringBuilder();for(byte value:MessageDigest.getInstance("SHA-256").digest(parts.toString().getBytes(StandardCharsets.UTF_8)))hash.append(String.format(Locale.ROOT,"%02x",value&255));
  return hash.toString();
 }
 public static JSONObject recover(JSONObject entry,String scope,String proposalId,String binding,Receipt receipt)throws Exception{
  if(entry==null||!scope.equals(entry.getString("scope"))||!proposalId.equals(entry.getString("proposalId")))throw new IllegalStateException("Notification journal identity changed");
  JSONObject record=entry.getJSONObject("record"),operation=record.getJSONObject("operation");
  if(!"post_notification".equals(operation.getString("type"))||record.optJSONObject("workflow")==null)throw new IllegalArgumentException("Not a workflow notification");
  if(!binding(entry,scope,proposalId).equals(binding))throw new IllegalStateException("Notification recovery binding changed");
  if("terminal".equals(entry.optString("phase"))&&!"unknown".equals(entry.optString("status")))return entry;
  if(entry.optString("attemptId").isEmpty()||!"applying".equals(entry.optString("phase"))&&!("terminal".equals(entry.optString("phase"))&&"unknown".equals(entry.optString("status"))))throw new IllegalStateException("Notification was not admitted");
  if(!"succeeded".equals(receipt.read(entry.getString("operationId"),binding,operation.getString("title"),operation.getString("body"))))return entry;
  return new JSONObject(entry.toString()).put("phase","terminal").put("status","succeeded").put("summary","Recovered the original notification delivery receipt. Nothing was posted again.").put("finishedAt",System.currentTimeMillis()).put("result",new JSONObject().put("operationId",entry.getString("operationId")));
 }
}
