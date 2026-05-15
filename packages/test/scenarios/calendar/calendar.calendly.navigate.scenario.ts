import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";

const THIRD_PARTY_CALENDLY_URL = "https://calendly.com/alex/intro";

export default scenario({
  id: "calendar.calendly.navigate",
  title: "Agent hands back a third-party Calendly booking link",
  domain: "calendar",
  tags: ["lifeops", "calendar", "calendly"],
  status: "pending",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Calendly Link Handoff",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "calendly-link-handoff",
      text: `I need the booking link for Alex's intro call: ${THIRD_PARTY_CALENDLY_URL}`,
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_CALENDLY_SLOT"],
        description: "third-party Calendly link handoff",
        includesAny: [THIRD_PARTY_CALENDLY_URL],
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "BOOK_CALENDLY_SLOT",
    },
    {
      type: "selectedActionArguments",
      actionName: "BOOK_CALENDLY_SLOT",
      includesAny: [THIRD_PARTY_CALENDLY_URL],
    },
    {
      type: "custom",
      name: "calendly-third-party-link-handoff",
      predicate: (ctx) => {
        const action = ctx.actionsCalled.find(
          (candidate) => candidate.actionName === "BOOK_CALENDLY_SLOT",
        );
        if (!action) {
          return "Expected BOOK_CALENDLY_SLOT to be selected.";
        }
        const data =
          action.result?.data && typeof action.result.data === "object"
            ? (action.result.data as Record<string, unknown>)
            : null;
        if (!data) {
          return "Expected BOOK_CALENDLY_SLOT to return structured data.";
        }
        if (data.bookingUrl !== THIRD_PARTY_CALENDLY_URL) {
          return `Expected bookingUrl ${THIRD_PARTY_CALENDLY_URL}, saw ${String(data.bookingUrl ?? "(missing)")}.`;
        }
        if (data.source !== "third-party") {
          return `Expected third-party source, saw ${String(data.source ?? "(missing)")}.`;
        }
        return undefined;
      },
    },
  ],
});
