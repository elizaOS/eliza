/**
 * Deterministic owner-voice drafting proof: two memo transcripts with distinct
 * affect become a persisted document artifact, then a later action turn reloads
 * that standing artifact without receiving its bytes and preserves an accepted
 * edit while revising only the targeted section.
 */

import type {
  CapturedAction,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function creativeActions(ctx: ScenarioContext): CapturedAction[] {
  return ctx.actionsCalled.filter(
    (action) => action.actionName === "CREATIVE_DRAFT",
  );
}

function assertComposeAndRevision(ctx: ScenarioContext): string | undefined {
  const actions = creativeActions(ctx);
  if (actions.length !== 2) {
    return `expected two CREATIVE_DRAFT calls, saw ${actions.length}`;
  }
  const composeData = record(actions[0]?.result?.data);
  const revisionData = record(actions[1]?.result?.data);
  const initial = record(composeData?.draft);
  const revised = record(revisionData?.draft);
  if (!composeData || !revisionData || !initial || !revised) {
    return "compose or revision action did not return a draft artifact";
  }
  const initialSections = initial.sections;
  const revisedSections = revised.sections;
  if (!Array.isArray(initialSections) || !Array.isArray(revisedSections)) {
    return "draft sections are missing";
  }
  const initialAffects = initialSections.map(
    (section) => record(section)?.affect,
  );
  if (initialAffects[0] !== "angry" || initialAffects[1] !== "reflective") {
    return `memo affects were not preserved: ${JSON.stringify(initialAffects)}`;
  }
  const initialMemoIds = initial.sourceMemoIds;
  if (
    !Array.isArray(initialMemoIds) ||
    initialMemoIds.join(",") !== "memo-anger,memo-hope"
  ) {
    return `memo provenance is wrong: ${JSON.stringify(initialMemoIds)}`;
  }
  const composeDocumentId = composeData.draftDocumentId;
  if (
    typeof composeDocumentId !== "string" ||
    composeDocumentId.length === 0 ||
    revisionData.draftDocumentId !== composeDocumentId
  ) {
    return "revision did not reload and update the same persisted draft document";
  }
  const acceptedEdits = revised.acceptedEdits;
  if (
    !Array.isArray(acceptedEdits) ||
    !acceptedEdits.includes("Sharper opening approved.")
  ) {
    return `accepted edit was lost: ${JSON.stringify(acceptedEdits)}`;
  }
  const secondSection = record(revisedSections[1]);
  if (
    secondSection?.text !==
    "We can still build the honest version if we stop hiding behind process."
  ) {
    return `targeted revision was not retained: ${JSON.stringify(secondSection)}`;
  }
  const firstBefore = record(initialSections[0]);
  const firstAfter = record(revisedSections[0]);
  if (firstBefore?.text !== firstAfter?.text) {
    return "revision regenerated the untouched angry section";
  }
  return undefined;
}

export default scenario({
  id: "creative-owner-voice-draft-persistence",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason:
      "Direct action turns exercise runtime contracts without model calls.",
  },
  title:
    "Owner voice draft preserves memo affect and reloads the standing artifact for revision",
  domain: "lifeops.creative",
  tags: [
    "pr",
    "deterministic",
    "lifeops",
    "creative-draft",
    "voice",
    "documents",
    "14871",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-personal-assistant"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Owner Voice Draft",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "compose two affected memos into a standing essay",
      room: "main",
      actionName: "CREATIVE_DRAFT",
      text: "Turn these two voice memos into an essay in my voice.",
      options: {
        parameters: {
          action: "compose",
          request: {
            title: "The Honest Version",
            targetForm: "essay",
            ownerAsk: "Turn these memos into an essay in my voice.",
            requestedVoice: "my voice, not consultant voice",
          },
          memos: [
            {
              id: "memo-anger",
              transcript:
                "They wasted six months and then asked everyone else to call it strategy.",
              affect: "angry",
              toneDirective: "Keep the anger in this section.",
            },
            {
              id: "memo-hope",
              transcript:
                "We can still build the honest version if we stop hiding behind process.",
              affect: "reflective",
            },
          ],
          ownerSources: [
            {
              id: "owner-essay",
              source: "essay",
              text: "Look, I think the point is simple. Say the hard thing plainly because people can feel when we sand the edges off.",
            },
            {
              id: "owner-mail",
              source: "sent_mail",
              text: "What matters is keeping the heat where the heat belongs. The useful version is direct and specific.",
            },
          ],
        },
      },
    },
    {
      kind: "action",
      name: "reload the standing artifact and revise only its second section",
      room: "main",
      actionName: "CREATIVE_DRAFT",
      text: "Keep the approved opening and make the second section land cleanly.",
      options: {
        parameters: {
          action: "revise",
          revision: {
            instruction:
              "Keep the approved opening and tighten the reflective close.",
            acceptedEdit: "Sharper opening approved.",
            sectionIndex: 1,
            replacementText:
              "We can still build the honest version if we stop hiding behind process.",
            revisedAt: "2026-08-06T12:00:00.000Z",
          },
        },
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CREATIVE_DRAFT",
      status: "success",
      minCount: 2,
    },
    {
      type: "custom",
      name: "memo affect, document identity, and accepted revision persist",
      predicate: assertComposeAndRevision,
    },
  ],
});
