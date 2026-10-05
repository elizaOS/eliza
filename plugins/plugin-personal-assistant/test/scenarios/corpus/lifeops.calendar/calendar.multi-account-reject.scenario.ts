/** Reject a selected-account proposal through the real owner approval action. */
import { AgentRuntime, getConnectorAccountManager } from "@elizaos/core";
import { scenario } from "@elizaos/testing";
import selectedWrite, {
  eventProposals,
} from "./calendar.multi-account-selected-write.scenario.ts";
import clarification from "./calendar.multi-account-selection.scenario.ts";

const unchanged = clarification.finalChecks?.find(
  (check) =>
    check.type === "custom" &&
    check.name === "calendar-unchanged-before-account-choice",
);
if (unchanged?.type !== "custom")
  throw new Error("Calendar mutation oracle required");

export default scenario({
  ...selectedWrite,
  id: "calendar.multi-account-reject",
  title: "Reject the selected Google account proposal without dispatching it",
  turns: [
    ...(selectedWrite.turns ?? []).slice(0, -1),
    {
      kind: "message",
      name: "reject-selected-account-proposal",
      room: "main",
      text: "No, reject the pending Cedar focus block proposal for work@company.test. Do not create the event.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    unchanged,
    {
      type: "custom",
      name: "selected-account-proposal-rejected",
      predicate: async (ctx) => {
        if (!(ctx.runtime instanceof AgentRuntime))
          throw new Error("Real runtime required");
        const account = (
          await getConnectorAccountManager(ctx.runtime).listAccounts("google")
        ).find((candidate) => candidate.externalId === "work@company.test");
        if (!account) return "Selected account missing";
        const proposals = await eventProposals(ctx.runtime);
        if (proposals.length !== 1 || proposals[0].state !== "rejected")
          return "Expected one rejected Calendar proposal and no pending duplicate";
        const payload = proposals[0].payload;
        return payload.action === "schedule_event" &&
          payload.grantId === `connector-account:${account.id}` &&
          payload.calendarId === "primary"
          ? undefined
          : "Rejected proposal was bound to the wrong account/calendar";
      },
    },
  ],
});
