import { scenario } from "@elizaos/scenario-runner/schema";
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
  lane: "live-only",
  id: "ea.docs.portal-upload-from-chat",
  title: "Upload a deck or asset to a portal from chat instructions",
  domain: "executive-assistant",
  tags: ["executive-assistant", "docs", "browser", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant takes a presentation asset from chat and uploads it to a speaker portal.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Portal Upload From Chat",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "portal-upload-request",
      room: "main",
      text: "When I send over the deck, upload it to the portal for me.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["COMPUTER_USE"],
        description: "portal upload task setup",
        includesAny: ["portal", "upload", "deck"],
      }),
      // Setup turn: the browser-task lifecycle finalChecks carry the
      // outcome; the reply must not claim the upload already happened
      // before the asset even arrives (hallucinated-completion decoy).
      responseExcludes: ["uploaded", "receipt", "completed the upload"],
    },
    {
      kind: "message",
      name: "portal-upload-asset-arrives",
      room: "main",
      text: "I sent the final deck. Upload it now, and if the speaker portal makes you wait for me to sign in, stop and tell me exactly what is blocking it.",
      assertTurn: expectTurnBrowserTask({
        description: "portal upload blocked on login after asset delivery",
        actionName: "COMPUTER_USE",
        approvalRequired: true,
        approvalSatisfied: true,
        needsHuman: true,
        minArtifacts: 1,
        minInterventions: 1,
        blockedReasonIncludes: "portal",
      }),
      // Derived blocked-state report: the reply must say the task is
      // paused/blocked awaiting the owner — none of these tokens appear in
      // any user turn, so echo cannot pass. Still no completion claim.
      responseIncludesAny: ["blocked", "paused", "waiting", "credentials"],
      responseExcludes: ["uploaded", "receipt"],
    },
    {
      kind: "message",
      name: "portal-upload-resume-after-help",
      room: "main",
      text: "I finished the portal sign-in. Resume the upload and send me the receipt link when it is done.",
      assertTurn: expectTurnBrowserTask({
        description: "portal upload resumed and completed with provenance",
        actionName: "COMPUTER_USE",
        completed: true,
        needsHuman: false,
        minArtifacts: 1,
        minUploadedAssets: 1,
        minProvenance: 1,
      }),
      // Derived completion report: "uploaded"/"successfully"/"complete"
      // appear in no user turn (the prompts only ever say "upload it"), so
      // only a real completion report passes.
      responseIncludesAny: ["uploaded", "successfully", "complete"],
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
      name: "ea-portal-upload-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["COMPUTER_USE"],
        description: "portal upload task setup",
        includesAny: ["portal", "upload", "deck"],
      }),
    },
    {
      type: "custom",
      name: "ea-portal-upload-browser-lifecycle",
      predicate: expectScenarioBrowserTask({
        description:
          "portal upload stayed approval-gated, paused for human help when login blocked the browser, then resumed and completed with provenance",
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
      name: "ea-portal-upload-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant accepted a portal upload from chat, paused for human sign-in intervention when blocked, resumed, completed the upload, and returned provenance such as the receipt link.",
    }),
  ],
});
