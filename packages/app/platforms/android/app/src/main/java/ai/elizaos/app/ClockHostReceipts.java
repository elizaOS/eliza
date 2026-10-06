package ai.elizaos.app;

import java.util.Locale;
import org.json.JSONObject;

/** Serializes an existing journal outcome against its exact trusted server claim. It cannot dispatch. */
final class ClockHostReceipts {
    static JSONObject result(ClockHandoff.Request request, ClockConsentCoordinator.Result outcome) throws Exception {
        return new JSONObject().put("kind", "clock-handoff").put("action", request.action.name().toLowerCase(Locale.ROOT))
                .put("status", outcome.name().toLowerCase(Locale.ROOT));
    }
    static JSONObject body(ClockHostClient.Proposal proposal, ClockConsentCoordinator.Identity identity,
                           ClockConsentCoordinator.Result outcome) throws Exception {
        if (!proposal.id.equals(identity.proposalId) || !proposal.id.equals(identity.operationId) || proposal.attemptId == null)
            throw new SecurityException("Clock receipt identity changed");
        JSONObject receipt = new JSONObject().put("outcome", outcome == ClockConsentCoordinator.Result.OPENED ? "applied"
                : outcome == ClockConsentCoordinator.Result.UNKNOWN ? "unknown" : "failed")
                .put("operationId", identity.operationId).put("code", "CLOCK_" + outcome.name()).put("result", result(proposal.request, outcome));
        return new JSONObject().put("digest", proposal.digest).put("attemptId", proposal.attemptId).put("receipt", receipt);
    }
}
