/**
 * 1Password autofill on Gmail login (also whitelisted by default).
 * User asks the agent to log them in; agent invokes autofill via the
 * browser extension.
 */

import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

const AUTOFILL_ACTIONS = ["AUTOFILL_FIELD", "AUTOFILL"];

export default scenario({
  id: "1password-autofill.whitelisted-gmail",
  title: "1Password autofill on whitelisted Gmail login",
  domain: "browser.lifeops",
  tags: ["browser", "autofill", "happy-path"],
  description:
    "User asks the agent to log into Gmail. The request should route to the whitelisted browser-extension autofill action and target gmail.com or google.com.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    credentials: ["1password:eliza-e2e-autofill"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Autofill: whitelisted Gmail",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "gmail-login-request",
      room: "main",
      text: "Use 1Password through the browser extension to fill my password on https://accounts.google.com/ServiceLogin.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: AUTOFILL_ACTIONS,
        description: "whitelisted Gmail autofill request",
      }),
      responseIncludesAny: [/gmail/i, /autofill|fill/i, /browser extension/i],
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: AUTOFILL_ACTIONS,
    },
    {
      type: "selectedActionArguments",
      actionName: AUTOFILL_ACTIONS,
      includesAny: ["google.com", "gmail.com", "password"],
    },
    {
      type: "custom",
      name: "autofill-gmail-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: AUTOFILL_ACTIONS,
        description: "whitelisted Gmail autofill request",
        includesAny: ["google.com", "password"],
      }),
    },
    {
      type: "custom",
      name: "autofill-gmail-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((action) =>
          AUTOFILL_ACTIONS.includes(action.actionName),
        );
        if (!hit) {
          return "expected whitelisted Gmail autofill action result";
        }
        const data = (hit.result?.data ?? {}) as {
          registrableDomain?: string;
          fieldPurpose?: string;
        };
        if (
          data.registrableDomain !== "google.com" &&
          data.registrableDomain !== "gmail.com"
        ) {
          return "expected google.com or gmail.com registrableDomain in autofill result";
        }
        if (data.fieldPurpose !== "password") {
          return "expected password fieldPurpose in autofill result";
        }
        return undefined;
      },
    },
  ],
});
