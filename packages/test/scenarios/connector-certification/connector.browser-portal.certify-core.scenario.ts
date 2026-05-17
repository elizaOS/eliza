import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";
import {
  expectScenarioBrowserTask,
  expectTurnBrowserTask,
} from "../_helpers/browser-task-assertions.ts";

export default scenario({
  id: "connector.browser-portal.certify-core",
  title: "Certify browser and portal upload flows",
  domain: "connector-certification",
  tags: [
    "connector-certification",
    "browser-portal",
    "connector-certification-axis:core",
  ],
  description:
    "Connector certification for browser automation uploads, blocked-state intervention, resumable portal sessions, and provenance after completion.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Certify browser and portal upload flows",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "browser-portal-core",
      room: "main",
      text: "Connector certification run for browser-portal. Perform the requested workflow now and do not ask which action to use. Upload the file through the portal, and if the browser gets blocked, ask me for help and resume after that.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["COMPUTER_USE"],
        description: "browser portal certification kickoff",
        includesAny: ["portal", "upload", "browser", "help"],
      }),
      responseIncludesAny: ["portal", "upload", "browser", "help"],
    },
    {
      kind: "message",
      name: "browser-portal-resume",
      room: "main",
      text: "The portal challenge is cleared. Resume the upload and return the portal receipt URL.",
      assertTurn: expectTurnBrowserTask({
        description:
          "browser portal certification completed after human resume",
        actionName: "COMPUTER_USE",
        completed: true,
        needsHuman: false,
        minArtifacts: 1,
        minUploadedAssets: 1,
        minInterventions: 1,
        minProvenance: 1,
      }),
      responseIncludesAny: ["upload", "portal", "receipt", "url"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "COMPUTER_USE",
    },
    {
      type: "browserTaskCompleted",
      expected: true,
    },
    {
      type: "uploadedAssetExists",
      expected: true,
    },
    {
      type: "custom",
      name: "connector.browser-portal.certify-core-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["COMPUTER_USE"],
        description: "browser portal connector certification",
        includesAny: ["portal", "upload", "browser", "help"],
      }),
    },
    {
      type: "custom",
      name: "connector.browser-portal.certify-core-lifecycle",
      predicate: expectScenarioBrowserTask({
        description:
          "browser portal connector blocks for human help, resumes, uploads the asset, and records provenance",
        actionName: "COMPUTER_USE",
        completed: true,
        approvalRequired: true,
        approvalSatisfied: true,
        needsHuman: false,
        minArtifacts: 1,
        minUploadedAssets: 1,
        minInterventions: 1,
        minProvenance: 1,
      }),
    },
    judgeRubric({
      name: "connector.browser-portal.certify-core-rubric",
      threshold: 0.7,
      description:
        "End-to-end: browser portal certification proves approval-gated upload, blocked human intervention, resumed completion, uploaded artifact capture, and provenance reporting.",
    }),
  ],
});
