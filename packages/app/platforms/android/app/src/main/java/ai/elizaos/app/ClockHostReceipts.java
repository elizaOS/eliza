package ai.elizaos.app;

import java.util.Locale;
import org.json.JSONObject;

/** Serializes an existing journal outcome against its exact trusted server claim. It cannot dispatch. */
final class ClockHostReceipts {
    static JSONObject result(ClockHandoff.Request request, ClockConsentCoordinator.Result outcome) throws Exception {
        return result(request, outcome, null, null);
    }
    static JSONObject result(ClockHandoff.Request request, ClockConsentCoordinator.Result outcome,
                             String effectReceipt, String operationId) throws Exception {
        if (request.owned) {
            if (outcome != ClockConsentCoordinator.Result.APPLIED)
                return new JSONObject().put("kind", "clock-alarm").put("action", request.action.name().toLowerCase(Locale.ROOT))
                        .put("status", outcome.name().toLowerCase(Locale.ROOT));
            JSONObject value = ClockHostClient.object(effectReceipt);
            String action = request.action.name().toLowerCase(Locale.ROOT);
            String status = request.action == ClockHandoff.Action.SET ? "scheduled"
                    : request.action == ClockHandoff.Action.UPDATE ? "updated"
                    : request.action == ClockHandoff.Action.DELETE ? "deleted"
                    : request.action == ClockHandoff.Action.ENABLE ? (request.enabled ? "enabled" : "disabled")
                    : request.action == ClockHandoff.Action.DISMISS ? "dismissed"
                    : request.action == ClockHandoff.Action.SNOOZE ? "snoozed" : "shown";
            if (!"clock-alarm".equals(value.getString("kind")) || !action.equals(value.getString("action"))
                    || !status.equals(value.getString("status"))) throw new SecurityException("Native alarm receipt changed");
            if (request.action == ClockHandoff.Action.SHOW) ClockHostClient.exact(value, "kind", "action", "status");
            else {
                if (request.action == ClockHandoff.Action.DELETE) ClockHostClient.exact(value, "kind", "action", "status", "alarmId");
                else ClockHostClient.exact(value, "kind", "action", "status", "alarmId", "nextAt");
                String expected = request.action == ClockHandoff.Action.SET ? operationId : request.alarmId;
                if (expected == null || !expected.equals(value.getString("alarmId")))
                    throw new SecurityException("Native alarm receipt selected another alarm");
                if (value.has("nextAt") && !value.isNull("nextAt")) {
                    Object next = value.get("nextAt");
                    if (!(next instanceof Integer || next instanceof Long) || ((Number) next).longValue() <= 0
                            || ((Number) next).longValue() > 9007199254740991L)
                        throw new SecurityException("Invalid native alarm receipt time");
                }
                if ((request.action == ClockHandoff.Action.SET || request.action == ClockHandoff.Action.SNOOZE
                        || (request.action == ClockHandoff.Action.ENABLE && request.enabled)) && value.isNull("nextAt"))
                    throw new SecurityException("Native alarm receipt has no scheduled time");
                if (request.action == ClockHandoff.Action.ENABLE && !request.enabled && !value.isNull("nextAt"))
                    throw new SecurityException("Disabled alarm still has a scheduled time");
            }
            return value;
        }
        if (outcome == ClockConsentCoordinator.Result.APPLIED) throw new SecurityException("Legacy handoff cannot prove an alarm effect");
        return new JSONObject().put("kind", "clock-handoff").put("action", request.action.name().toLowerCase(Locale.ROOT))
                .put("status", outcome.name().toLowerCase(Locale.ROOT));
    }
    static JSONObject body(ClockHostClient.Proposal proposal, ClockConsentCoordinator.Identity identity,
                           ClockConsentCoordinator.Result outcome) throws Exception {
        return body(proposal, identity, outcome, null);
    }
    static JSONObject body(ClockHostClient.Proposal proposal, ClockConsentCoordinator.Identity identity,
                           ClockConsentCoordinator.Result outcome, String effectReceipt) throws Exception {
        if (!proposal.id.equals(identity.proposalId) || !proposal.id.equals(identity.operationId) || proposal.attemptId == null)
            throw new SecurityException("Clock receipt identity changed");
        JSONObject receipt = new JSONObject().put("outcome", outcome == ClockConsentCoordinator.Result.OPENED || outcome == ClockConsentCoordinator.Result.APPLIED ? "applied"
                : outcome == ClockConsentCoordinator.Result.UNKNOWN ? "unknown" : "failed")
                .put("operationId", identity.operationId).put("code", "CLOCK_" + outcome.name())
                .put("result", result(proposal.request, outcome, effectReceipt, identity.operationId));
        return new JSONObject().put("digest", proposal.digest).put("attemptId", proposal.attemptId).put("receipt", receipt);
    }
}
