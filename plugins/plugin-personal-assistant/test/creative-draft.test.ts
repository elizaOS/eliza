/**
 * Creative-draft tests pin the owner-voice artifact contract before live voice
 * memo scenarios exercise it through the model loop.
 */

import { describe, expect, it } from "vitest";
import {
  applyCreativeDraftRevision,
  buildCreativeDraftPrompt,
  buildOwnerVoiceStyleCard,
  type CreativeMemoTranscript,
  createCreativeDraftArtifact,
  type OwnerVoiceSource,
  scoreOwnerVoiceFidelity,
} from "../src/lifeops/creative-draft/index.js";

const ownerSources: OwnerVoiceSource[] = [
  {
    id: "essay-1",
    source: "essay",
    text: "Look, I think the point is simple. We should say the hard thing plainly because the audience can feel when we sand the edges off.",
  },
  {
    id: "mail-1",
    source: "sent_mail",
    text: "I think the useful version is direct and specific. What matters is keeping the heat where the heat belongs.",
  },
  {
    id: "thread-1",
    source: "thread",
    text: "Look, I want the piece to move fast. The point is not polish; the point is nerve.",
  },
];

const memos: CreativeMemoTranscript[] = [
  {
    id: "memo-anger",
    transcript:
      "The second section needs to stay angry. They wasted six months and then asked everyone else to call it strategy.",
    affect: "angry",
    toneDirective: "Keep the anger in the second section.",
    capturedAt: "2026-07-06T10:00:00.000Z",
  },
  {
    id: "memo-hope",
    transcript:
      "End by saying we can still build the honest version if we stop hiding behind process.",
    affect: "reflective",
    capturedAt: "2026-07-06T10:04:00.000Z",
  },
];

describe("creative draft owner-voice primitives", () => {
  it("builds a style card from owner-authored examples", () => {
    const card = buildOwnerVoiceStyleCard(ownerSources);

    expect(card.sourceIds).toEqual(["essay-1", "mail-1", "thread-1"]);
    expect(card.stanceMarkers).toEqual(
      expect.arrayContaining(["I think", "look", "the point is"]),
    );
    expect(card.signaturePhrases).toContain("the point");
    expect(card.avoidPhrases).toContain("leverage synergies");
  });

  it("maps memo affect into draft sections and prompt payload", () => {
    const styleCard = buildOwnerVoiceStyleCard(ownerSources);
    const request = {
      title: "Honest Strategy Essay",
      targetForm: "essay" as const,
      ownerAsk: "Turn these memos into an essay in my voice.",
      requestedVoice: "my voice, not consultant voice",
    };
    const draft = createCreativeDraftArtifact({
      request,
      memos,
      styleCard,
      nowIso: "2026-07-06T10:10:00.000Z",
    });
    const prompt = buildCreativeDraftPrompt({
      request,
      memos,
      styleCard,
      currentDraft: draft,
    });

    expect(draft.sourceMemoIds).toEqual(["memo-anger", "memo-hope"]);
    expect(draft.sections[0]).toMatchObject({
      memoId: "memo-anger",
      affect: "angry",
      directive: "Keep the anger in the second section.",
    });
    expect(prompt).toContain('"task": "creative_draft"');
    expect(prompt).toContain("not like a consultant");
    expect(prompt).toContain("Keep the anger in the second section.");
    expect(prompt).toContain('"acceptedEdits": []');
  });

  it("scores owner-like copy above a generic consultant baseline", () => {
    const styleCard = buildOwnerVoiceStyleCard(ownerSources);
    const ownerLike =
      "Look, I think the point is simple. What matters is keeping the heat where the heat belongs.";
    const generic =
      "This best-in-class framework will unlock value and leverage synergies across a robust operating model.";

    expect(scoreOwnerVoiceFidelity(ownerLike, styleCard)).toBeGreaterThan(
      scoreOwnerVoiceFidelity(generic, styleCard),
    );
  });

  it("revisions preserve accepted edits and vetoed phrases across turns", () => {
    const styleCard = buildOwnerVoiceStyleCard(ownerSources);
    const request = {
      title: "Launch Narrative",
      targetForm: "launch_thread" as const,
      ownerAsk: "Make this sound like me on a good day.",
    };
    const initial = createCreativeDraftArtifact({
      request,
      memos,
      styleCard,
      nowIso: "2026-07-06T10:10:00.000Z",
    });
    const revised = applyCreativeDraftRevision(initial, {
      instruction: "Keep the sharper opening; never say best-in-class.",
      acceptedEdit: "Sharper opening approved.",
      vetoedPhrase: "best-in-class",
      replacementText: "Look, the honest version starts by naming the waste.",
      revisedAt: "2026-07-06T10:20:00.000Z",
    });

    expect(revised.id).toBe(initial.id);
    expect(revised.acceptedEdits).toEqual(["Sharper opening approved."]);
    expect(revised.vetoedPhrases).toEqual(["best-in-class"]);
    expect(revised.sections[0]?.text).toBe(
      "Look, the honest version starts by naming the waste.",
    );
    expect(revised.sections[1]).toEqual(initial.sections[1]);
  });

  it("revises a non-first section by sectionIndex", () => {
    const styleCard = buildOwnerVoiceStyleCard(ownerSources);
    const initial = createCreativeDraftArtifact({
      request: {
        title: "Two-part memo",
        targetForm: "memo" as const,
        ownerAsk: "Draft this.",
      },
      memos,
      styleCard,
      nowIso: "2026-07-06T10:10:00.000Z",
    });

    const revised = applyCreativeDraftRevision(initial, {
      instruction: "Soften the closing.",
      sectionIndex: 1,
      replacementText: "We can still build the honest version.",
      revisedAt: "2026-07-06T10:30:00.000Z",
    });

    // The first section is untouched; only the targeted second section changes.
    expect(revised.sections[0]).toEqual(initial.sections[0]);
    expect(revised.sections[1]?.text).toBe(
      "We can still build the honest version.",
    );
  });

  it("revises a non-first section by sectionId regardless of position", () => {
    const styleCard = buildOwnerVoiceStyleCard(ownerSources);
    const initial = createCreativeDraftArtifact({
      request: {
        title: "Two-part memo",
        targetForm: "memo" as const,
        ownerAsk: "Draft this.",
      },
      memos,
      styleCard,
      nowIso: "2026-07-06T10:10:00.000Z",
    });
    const targetSection = initial.sections[1];
    if (!targetSection) throw new Error("expected a second section");

    const revised = applyCreativeDraftRevision(initial, {
      instruction: "Rewrite the hopeful close.",
      sectionId: targetSection.id,
      replacementText: "Stop hiding behind process and ship the honest one.",
      revisedAt: "2026-07-06T10:35:00.000Z",
    });

    expect(revised.sections[0]).toEqual(initial.sections[0]);
    expect(revised.sections[1]?.text).toBe(
      "Stop hiding behind process and ship the honest one.",
    );
  });

  it("rejects a revision whose target section does not exist", () => {
    const styleCard = buildOwnerVoiceStyleCard(ownerSources);
    const initial = createCreativeDraftArtifact({
      request: {
        title: "Two-part memo",
        targetForm: "memo" as const,
        ownerAsk: "Draft this.",
      },
      memos,
      styleCard,
      nowIso: "2026-07-06T10:10:00.000Z",
    });

    expect(() =>
      applyCreativeDraftRevision(initial, {
        instruction: "Edit a section that isn't there.",
        sectionIndex: 9,
        replacementText: "orphan text",
        revisedAt: "2026-07-06T10:40:00.000Z",
      }),
    ).toThrow(/unknown section/u);
    expect(() =>
      applyCreativeDraftRevision(initial, {
        instruction: "Edit by a bogus id.",
        sectionId: "section_does_not_exist",
        replacementText: "orphan text",
        revisedAt: "2026-07-06T10:41:00.000Z",
      }),
    ).toThrow(/unknown section/u);
  });

  it("sources instructions through OptimizedPromptService when a runtime is supplied", () => {
    const styleCard = buildOwnerVoiceStyleCard(ownerSources);
    const request = {
      title: "Optimized Draft",
      targetForm: "essay" as const,
      ownerAsk: "Draft in my voice.",
    };
    const optimizedInstructions =
      "OPTIMIZED creative_draft instructions — write in the owner's voice.";
    const runtime = {
      getService(name: string) {
        if (name !== "optimized_prompt") return null;
        return {
          getPrompt(task: string) {
            return task === "creative_draft"
              ? { prompt: optimizedInstructions, optimizerSource: "gepa" }
              : null;
          },
        };
      },
    };

    const optimizedPrompt = buildCreativeDraftPrompt({
      request,
      memos,
      styleCard,
      runtime,
    });
    const baselinePrompt = buildCreativeDraftPrompt({
      request,
      memos,
      styleCard,
    });

    expect(optimizedPrompt).toContain(optimizedInstructions);
    expect(optimizedPrompt).not.toContain("not like a consultant");
    // Absent a runtime, the inline baseline is used unchanged.
    expect(baselinePrompt).toContain("not like a consultant");
    // The structured data payload is composed around the resolved instructions
    // in both cases.
    expect(optimizedPrompt).toContain('"task": "creative_draft"');
  });
});
