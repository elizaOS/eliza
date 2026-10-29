package ai.eliza.plugins.actionjournal.deletion;

import ai.eliza.plugins.actionjournal.ActionJournal;
import java.util.Iterator;
import org.json.JSONObject;

/**
 * Read-only reconciliation of a claimed agent deletion against its Undo-window receipt.
 * Missing or mismatched evidence returns the entry unchanged and never authorizes a write; an
 * unknown or dispatching receipt is never settled. Supports {@code calendar_delete} and
 * {@code reminder_cancel} operations.
 */
public final class DeletionReceiptRecovery {
 public static JSONObject recover(JSONObject entry, JSONObject receipt, JSONObject reminderResult) throws Exception {
  if (entry == null || receipt == null || !entry.has("nativeDispatchClaim")) return entry;
  if ("terminal".equals(entry.optString("phase")) && !"unknown".equals(entry.optString("status"))) return entry;
  if (!"applying".equals(entry.optString("phase")) && !"unknown".equals(entry.optString("status"))) return entry;
  JSONObject claim = entry.getJSONObject("nativeDispatchClaim"), operation = entry.getJSONObject("record").getJSONObject("operation");
  String type = operation.getString("type"), id = entry.getString("operationId");
  if (!"deletion".equals(claim.optString("kind")) || !id.equals(claim.optString("operationId")) || !id.equals(receipt.optString("id"))) return entry;
  JSONObject owner = receipt.optJSONObject("owner");
  if (owner == null && receipt.opt("owner") instanceof String) owner = new JSONObject(receipt.getString("owner"));
  if (!ActionJournal.sameJson(owner, claim.optJSONObject("owner"))) return entry;
  JSONObject target = receipt.getJSONObject("target"), binding;
  if ("calendar_delete".equals(type)) binding = target.optJSONObject("journalBinding");
  else if ("reminder_cancel".equals(type)) {
   JSONObject opBinding = receipt.optJSONObject("operationBinding");
   if (opBinding == null || !ActionJournal.sameJson(operation, opBinding.optJSONObject("operation"))) return entry;
   binding = opBinding.optJSONObject("journalBinding");
  } else return entry;
  if (binding == null) return entry;
  for (String field : new String[] {"scope", "proposalId", "operationHash"}) if (!entry.getString(field).equals(binding.optString(field))) return entry;
  JSONObject expected = operation.getJSONObject("target");
  for (Iterator<String> keys = expected.keys(); keys.hasNext();) { String key = keys.next(); if (!ActionJournal.sameJson(expected.get(key), target.opt(key))) return entry; }
  String phase = receipt.getString("phase");
  if (!"deleted".equals(phase) && !"undone".equals(phase) && !"conflict".equals(phase)) return entry;
  JSONObject result = new JSONObject().put("operationId", id);
  boolean success = "deleted".equals(phase);
  if (success) {
   if ("calendar_delete".equals(type)) {
    if (!"deleted".equals(receipt.getJSONObject("outcome").optString("status"))) return entry;
    result.put("calendarResult", new JSONObject().put("version", 1).put("kind", type).put("sourceId", target.getString("sourceId")).put("eventId", target.getString("eventId")).put("revision", target.getString("revision")));
   } else {
    if (!"complete".equals(receipt.optString("effects")) && !"superseded".equals(receipt.optString("effects"))) return entry;
    if (reminderResult == null || !type.equals(reminderResult.optString("kind")) || !"cancelled".equals(reminderResult.optString("status"))) return entry;
    for (String field : new String[] {"sourceId", "reminderId", "occurrenceId"}) if (!target.getString(field).equals(reminderResult.optString(field))) return entry;
    result.put("reminderResult", reminderResult);
   }
  }
  return new JSONObject(entry.toString()).put("phase", "terminal").put("status", success ? "succeeded" : "failed").put("finishedAt", System.currentTimeMillis())
   .put("summary", success ? "Recovered the verified deletion receipt. No action was repeated." : "undone".equals(phase) ? "Deletion was undone. The original item was retained." : "The item changed before deletion; no deletion was applied.")
   .put("result", result);
 }

 private DeletionReceiptRecovery() {}
}
