package ai.elizaos.app;

import java.time.Instant;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real org.json and production claim decoder only. No Android store, credentials, native UI or dispatch. */
public final class ClockHostClaimTest {
    private static int checks;
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
    private static void rejects(Checked action) throws Exception {
        try { action.run(); } catch (Exception expected) { checks++; return; }
        throw new AssertionError("Untrusted native claim admitted");
    }
    private static JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
    private static JSONObject operation() throws Exception {
        return new JSONObject().put("type", "clock_handoff").put("action", "set").put("hour", 9).put("minute", 0)
                .put("label", "Wake up").put("timeZone", "UTC").put("days", new JSONArray(List.of(2, 3, 4, 5, 6)));
    }
    private static JSONObject proposal(JSONObject context) throws Exception {
        return new JSONObject().put("id", "proposal").put("digest", "b".repeat(64)).put("state", "executing")
                .put("expiresAt", Instant.now().plusSeconds(300).toString()).put("subjectUserId", context.get("subjectUserId"))
                .put("resolvedBy", context.get("subjectUserId")).put("resolutionReason", "Explicit device review:" + "b".repeat(64))
                .put("payload", new JSONObject().put("action", "device_action").put("version", 1).put("installationId", context.get("installationId"))
                        .put("enrollmentId", context.get("enrollmentId")).put("operation", operation()))
                .put("execution", new JSONObject().put("attemptId", "attempt").put("dispatchStartedAt", Instant.now().toString()));
    }
    public static void main(String[] args) throws Exception {
        JSONObject context = new JSONObject().put("agentId", "agent").put("subjectUserId", "gateway:fixture-owner")
                .put("installationId", "installation").put("enrollmentId", "enrollment").put("scope", "a".repeat(64));
        JSONObject raw = proposal(context);
        ClockHostClient.Proposal decoded = new ClockHostClient.Proposal(raw, context);
        check(decoded.request.days.equals(List.of(2, 3, 4, 5, 6)), "Exact native repeat lost");
        ClockConsentCoordinator.ApprovedEntry entry = ClockHostClient.admitted(context, decoded, "c".repeat(64));
        check(entry.identity.scope.equals(context.getString("scope")) && entry.identity.proposalId.equals("proposal")
                && entry.identity.operationId.equals("proposal"), "Native journal identity not bound");
        check(entry.claimDigest.equals(ClockHostPolicy.hash("b".repeat(64) + "\nattempt\n" + "a".repeat(64))), "Native attempt/digest/scope binding changed");
        JSONObject summary = decoded.summary();
        ClockHostClient.exact(summary, "id", "digest", "state", "expiresAt", "operation"); checks++;
        check(!summary.toString().contains("gateway:") && !summary.has("execution") && !summary.has("payload"), "Proposal summary exposes private host authority");
        JSONObject changed = copy(raw); changed.put("subjectUserId", "other");
        JSONObject otherOwner = changed; rejects(() -> new ClockHostClient.Proposal(otherOwner, context));
        changed = copy(raw); changed.getJSONObject("payload").put("installationId", "other");
        JSONObject otherInstall = changed; rejects(() -> new ClockHostClient.Proposal(otherInstall, context));
        changed = copy(raw); changed.getJSONObject("payload").put("enrollmentId", "other");
        JSONObject otherEnrollment = changed; rejects(() -> new ClockHostClient.Proposal(otherEnrollment, context));
        changed = copy(raw); changed.put("digest", "renderer-approval");
        JSONObject badDigest = changed; rejects(() -> new ClockHostClient.Proposal(badDigest, context));
        changed = copy(raw); changed.getJSONObject("payload").put("workflow", new JSONObject());
        JSONObject workflow = changed; rejects(() -> new ClockHostClient.Proposal(workflow, context));
        for (String field : new String[]{"resolvedBy", "resolutionReason"}) {
            JSONObject bad = copy(raw).put(field, "renderer-approved");
            rejects(() -> ClockHostClient.admitted(context, new ClockHostClient.Proposal(bad, context), "c".repeat(64)));
        }
        for (String state : new String[]{"pending", "approved", "rejected"}) {
            JSONObject bad = copy(raw).put("state", state);
            rejects(() -> ClockHostClient.admitted(context, new ClockHostClient.Proposal(bad, context), "c".repeat(64)));
        }
        changed = copy(raw); changed.remove("execution");
        JSONObject noAttempt = changed; rejects(() -> ClockHostClient.admitted(context, new ClockHostClient.Proposal(noAttempt, context), "c".repeat(64)));
        changed = copy(raw); changed.getJSONObject("execution").remove("dispatchStartedAt");
        JSONObject noDispatch = changed; rejects(() -> ClockHostClient.admitted(context, new ClockHostClient.Proposal(noDispatch, context), "c".repeat(64)));
        changed = copy(raw); changed.getJSONObject("execution").put("attemptId", "other-attempt");
        check(!entry.claimDigest.equals(ClockHostClient.admitted(context, new ClockHostClient.Proposal(changed, context), "c".repeat(64)).claimDigest), "Attempt substitution not bound");
        JSONObject alteredScope = copy(context).put("scope", "d".repeat(64));
        check(!entry.claimDigest.equals(ClockHostClient.admitted(alteredScope, decoded, "c".repeat(64)).claimDigest), "Context scope substitution not bound");
        JSONObject approved = copy(raw).put("state", "approved"); approved.remove("execution");
        ClockHostClient.Proposal unclaimedApproved = new ClockHostClient.Proposal(approved, context);
        check(!ClockHostClient.requiresDecision(context, unclaimedApproved), "Owned approved/no-attempt resume must skip duplicate approval");
        JSONObject pending = copy(approved).put("state", "pending"); pending.remove("resolvedBy"); pending.remove("resolutionReason");
        ClockHostClient.Proposal unclaimedPending = new ClockHostClient.Proposal(pending, context);
        check(ClockHostClient.requiresDecision(context, unclaimedPending), "Unclaimed pending review must still require server approval");
        ClockHostClient.sameProposal(unclaimedPending, unclaimedApproved); checks++;
        for (String field : new String[]{"resolvedBy", "resolutionReason"}) {
            JSONObject bad = copy(approved).put(field, "wrong-native-owner-review");
            rejects(() -> ClockHostClient.requiresDecision(context, new ClockHostClient.Proposal(bad, context)));
        }
        for (String state : new String[]{"executing", "done", "reconciliation_required", "rejected", "expired"}) {
            JSONObject bad = copy(approved).put("state", state);
            rejects(() -> ClockHostClient.requiresDecision(context, new ClockHostClient.Proposal(bad, context)));
        }
        for (String state : new String[]{"pending", "approved", "executing", "done", "reconciliation_required"}) {
            JSONObject claimed = copy(raw).put("state", state);
            rejects(() -> ClockHostClient.requiresDecision(context, new ClockHostClient.Proposal(claimed, context)));
        }
        JSONObject expiredApproval = copy(approved).put("expiresAt", Instant.now().minusSeconds(1).toString());
        rejects(() -> ClockHostClient.requiresDecision(context, new ClockHostClient.Proposal(expiredApproval, context)));
        JSONObject changedApprovedDigest = copy(approved).put("digest", "e".repeat(64));
        rejects(() -> ClockHostClient.requiresDecision(context, new ClockHostClient.Proposal(changedApprovedDigest, context)));
        JSONObject malformedExecution = copy(approved).put("execution", "not-an-attempt");
        rejects(() -> new ClockHostClient.Proposal(malformedExecution, context));
        JSONObject legacy = operation(); legacy.remove("days");
        check(ClockHostClient.decode(legacy).days == null, "Legacy omission became explicit repeat");
        check(ClockHostClient.decode(operation().put("days", new JSONArray())).days.equals(List.of()), "Explicit one-off lost");
        rejects(() -> ClockHostClient.decode(operation().put("days", JSONObject.NULL)));
        rejects(() -> ClockHostClient.decode(operation().put("days", new JSONArray(List.of("2")))));
        rejects(() -> ClockHostClient.decode(operation().put("days", new JSONArray(List.of(2, 2)))));
        rejects(() -> ClockHostClient.decode(operation().put("days", new JSONArray(List.of(0)))));
        rejects(() -> ClockHostClient.decode(operation().put("days", new JSONArray(List.of(8)))));
        rejects(() -> ClockHostClient.decode(operation().put("days", new JSONArray(List.of(2.5)))));
        rejects(() -> ClockHostClient.decode(operation().put("hour", "9")));
        rejects(() -> ClockHostClient.decode(operation().put("approved", true)));
        rejects(() -> ClockHostClient.decode(new JSONObject().put("type", "clock_handoff").put("action", "show").put("days", new JSONArray())));
        rejects(() -> ClockHostClient.object("{} false"));
        rejects(() -> ClockHostClient.object("[]"));
        System.out.println("Native Clock claim decoder passed: " + checks + " checks; no native credentials or Android dispatch");
    }
}
