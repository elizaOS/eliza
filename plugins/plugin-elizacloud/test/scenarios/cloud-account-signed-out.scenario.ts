/**
 * Signed-out gating for the cloud account action surface: without a Cloud
 * session (`CLOUD_AUTH` unauthenticated — no ELIZAOS_CLOUD_API_KEY in the
 * deterministic lane), the account actions' validate() must keep them out of
 * the planner entirely, and the reply must not pretend to know account state.
 * The signed-in paths are covered by the loopback-server unit suites
 * (__tests__/unit/cloud-account-actions.test.ts).
 */
import { scenario } from "@elizaos/scenario-runner/schema";
export default scenario({
  lane: "pr-deterministic",
  id: "cloud-account-signed-out",
  title: "Cloud account actions stay hidden without a Cloud session",
  domain: "elizacloud.account",
  tags: ["elizacloud", "cloud", "actions", "gating"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-elizacloud"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Cloud Account",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "credits-question-signed-out",
      text: "How many credits do I have on Eliza Cloud, and what agents are running?",
      plannerExcludes: [
        "CLOUD_ACCOUNT_STATUS",
        "CLOUD_LIST_AGENTS",
        "CLOUD_CREATE_API_KEY",
      ],
      responseIncludesAny: [
        "cloud",
        "sign",
        "connect",
        "account",
        "credit",
        "log in",
      ],
    },
  ],
});
