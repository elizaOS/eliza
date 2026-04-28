import { scenario } from "@elizaos/scenario-schema";
import {
  attachFakeSubscriptionComputerUse,
  FakeSubscriptionComputerUseService,
} from "../../helpers/subscription-computer-use-fixture";
import { expectScenarioBrowserTask } from "../_helpers/browser-task-assertions.ts";

export default scenario({
  id: "subscriptions.login-required",
  title: "Subscription cancellation that needs login",
  domain: "browser.lifeops",
  tags: ["browser", "subscriptions", "human-handoff"],
  description:
    "The agent should detect that the subscription flow needs the user to sign in and stop without pretending the cancellation completed.",
  isolation: "per-scenario",
  seed: [
    {
      type: "custom",
      name: "attach-fake-computeruse",
      apply: (ctx) => {
        const runtime = ctx.runtime as {
          getService?: (serviceType: string) => unknown;
        };
        attachFakeSubscriptionComputerUse(
          runtime,
          new FakeSubscriptionComputerUseService("fixture_login_required"),
        );
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Fixture Login Required subscription",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "cancel-login-required",
      room: "main",
      text: "Cancel my Fixture Login Required subscription.",
      responseIncludesAny: ["needs", "sign in", "cancellation"],
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find(
          (action) => action.actionName === "SUBSCRIPTIONS",
        );
        if (!hit) {
          return "expected SUBSCRIPTIONS to run";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    { type: "selectedAction", actionName: "SUBSCRIPTIONS" },
    { type: "browserTaskNeedsHuman", expected: true },
    { type: "browserTaskCompleted", expected: false },
    {
      type: "custom",
      name: "subscriptions-login-required-browser-task-shape",
      predicate: expectScenarioBrowserTask({
        description:
          "login-required cancellation stops with a human-needed browser task and no completion artifact",
        actionName: "SUBSCRIPTIONS",
        completed: false,
        needsHuman: true,
        minInterventions: 0,
      }),
    },
  ],
});
