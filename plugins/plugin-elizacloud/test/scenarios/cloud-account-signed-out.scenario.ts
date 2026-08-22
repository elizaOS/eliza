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
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "signed-out-cloud-account-reply",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: {
            includes:
              "How many credits do I have on Eliza Cloud, and what agents are running?",
          },
          toolNames: ["HANDLE_RESPONSE"],
        },
        cardinality: 1,
        response: {
          json: {
            contexts: ["cloud"],
            intents: ["cloud account status"],
            replyText:
              "Sign in to connect your Eliza Cloud account and view credits.",
            threadOps: [],
            candidateActionNames: [],
          },
        },
      },
      {
        name: "signed-out-cloud-account-planner",
        match: {
          modelType: "ACTION_PLANNER",
          toolNames: [],
          input: {
            includes:
              "How many credits do I have on Eliza Cloud, and what agents are running?",
          },
        },
        cardinality: 1,
        response: {
          json: {
            thought: "Cloud account tools are unavailable while signed out.",
            messageToUser:
              "Sign in to connect your Eliza Cloud account and view credits.",
            completed: true,
          },
        },
      },
      {
        name: "signed-out-cloud-account-post-turn-evaluation",
        match: {
          modelType: "TEXT_SMALL",
          input: { includes: "# Task: Post-turn evaluation" },
          toolNames: [],
        },
        cardinality: 1,
        response: {
          text: '{"factMemory":{"ops":[]},"preferences":{"ops":[]},"relationships":{"relationships":[]},"identities":{"identities":[]},"success":{"completed":true,"reason":"Explained that Cloud account access requires sign-in."},"ftu_goal_discovery":{"goalFound":false,"goal":"","confidence":0},"experiencePatterns":{"experiences":[]}}',
        },
      },
    ],
  },
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
