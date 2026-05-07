/**
 * 1Password autofill on a whitelisted site (GitHub). The user asks
 * the agent to log them in; the agent should invoke the autofill
 * action through the browser extension, scoped to sites in the
 * autofill whitelist.
 */

import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

const AUTOFILL_ACTIONS = ["AUTOFILL_FIELD", "AUTOFILL"];

export default scenario({
  id: "1password-autofill.whitelisted-site",
  title: "1Password autofill on whitelisted GitHub login",
  domain: "browser.lifeops",
  tags: ["browser", "autofill", "happy-path"],
  description:
    "User asks the agent to log into GitHub. The request should route to the whitelisted browser-extension autofill action and target github.com without exposing credentials to the model.",
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
      title: "Autofill: whitelisted GitHub",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "github-login-request",
      room: "main",
      text: "Use 1Password through the browser extension to fill my password on https://github.com/login.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: AUTOFILL_ACTIONS,
        description: "whitelisted GitHub autofill request",
      }),
      responseIncludesAny: [/github/i, /autofill|fill/i, /browser extension/i],
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
      includesAny: ["github.com", "password"],
    },
    {
      type: "custom",
      name: "autofill-github-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: AUTOFILL_ACTIONS,
        description: "whitelisted GitHub autofill request",
        includesAny: ["github.com", "password"],
      }),
    },
    {
      type: "custom",
      name: "autofill-github-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((action) =>
          AUTOFILL_ACTIONS.includes(action.actionName),
        );
        if (!hit) {
          return "expected whitelisted GitHub autofill action result";
        }
        const data = (hit.result?.data ?? {}) as {
          registrableDomain?: string;
          fieldPurpose?: string;
        };
        if (data.registrableDomain !== "github.com") {
          return "expected github.com registrableDomain in autofill result";
        }
        if (data.fieldPurpose !== "password") {
          return "expected password fieldPurpose in autofill result";
        }
        return undefined;
      },
    },
  ],
});
