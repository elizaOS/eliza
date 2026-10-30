package ai.eliza.plugins.actionjournal.deletion;

import ai.eliza.plugins.actionjournal.ActionJournal;
import org.json.JSONObject;

/**
 * Binds an agent-approved deletion to its exact action-journal entry with a permanent
 * {@code nativeDispatchClaim}. The claim lives in the existing receipt, not in renderer-owned
 * recovery state, so a claimed operation can neither be staged twice nor be replaced by a
 * renderer settlement or a cached recovery.
 *
 * <p>The approved record carries {@code agentId}, {@code installationId}, {@code enrollmentId}
 * and {@code ownerId}; the authenticated native owner is {@code {kind: "agent", identity:
 * {subjectUserId, agentId, installationId, enrollmentId, ...}}}.
 */
public final class DeletionDispatchClaim {
 private static final String[] OWNER_FIELDS = {"agentId", "installationId", "enrollmentId"};

 /** The journal binding a staged target carries ({@code scope}, {@code proposalId}, {@code operationHash}). */
 public static JSONObject binding(ActionJournal journal, JSONObject identity) throws Exception {
  JSONObject entry = journal.get(identity.getString("scope"), identity.getString("proposalId"));
  if (entry == null || !entry.has("nativeDispatchClaim")) throw new SecurityException("Deletion claim missing");
  return new JSONObject().put("scope", entry.getString("scope")).put("proposalId", entry.getString("proposalId")).put("operationHash", entry.getString("operationHash"));
 }

 /**
  * Checks that {@code operation} is the unexpired, non-sensitive, applying, unclaimed entry for
  * {@code operationId} and that {@code owner} is its agent and account. With {@code claim} the
  * permanent claim is written under the journal lock.
  */
 public static void check(ActionJournal journal, JSONObject identity, String operationId, JSONObject operation, JSONObject owner, boolean claim) throws Exception {
  if (identity == null || owner == null || !"agent".equals(owner.getString("kind"))) throw new SecurityException("Native action identity required");
  String scope = ActionJournal.scope(identity.getString("scope")), proposal = ActionJournal.id(identity.getString("proposalId"));
  synchronized (journal.lock()) {
   JSONObject entry = journal.get(scope, proposal);
   if (entry == null || !"applying".equals(entry.getString("phase")) || !operationId.equals(entry.getString("operationId")) || entry.has("nativeDispatchClaim")) throw new SecurityException("Action already claimed or retired");
   JSONObject record = entry.getJSONObject("record"), nativeOwner = owner.getJSONObject("identity");
   if (record.getLong("expiresAt") <= System.currentTimeMillis() || record.getJSONObject("context").optBoolean("sensitive") || !ActionJournal.sameJson(record.getJSONObject("operation"), operation)) throw new SecurityException("Approved deletion changed");
   for (String field : OWNER_FIELDS) if (!record.getString(field).equals(nativeOwner.getString(field))) throw new SecurityException("Action owner changed");
   if (!record.getString("ownerId").equals(nativeOwner.getString("subjectUserId"))) throw new SecurityException("Action account changed");
   if (claim) journal.update(scope, proposal, current -> {
    current.put("nativeDispatchClaim", new JSONObject().put("kind", "deletion").put("operationId", operationId).put("owner", new JSONObject(owner.toString())));
    return current;
   });
  }
 }

 private DeletionDispatchClaim() {}
}
