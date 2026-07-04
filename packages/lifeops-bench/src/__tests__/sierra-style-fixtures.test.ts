/**
 * Verifies the synthetic Sierra-style fixture contracts with deterministic
 * backend state and report validation checks.
 */
import { describe, expect, it } from "vitest";
import { LifeOpsFakeBackend } from "../lifeops-fake-backend.js";
import {
  createSierraStyleKnowledgeFixture,
  SIERRA_STYLE_VOICE_INTERRUPTION_FIXTURE,
  type SierraStyleVoiceReport,
  scoreSierraStyleKnowledgeFixture,
  validateSierraStyleVoiceReport,
} from "../sierra-style-fixtures.js";

describe("Sierra-style benchmark fixtures", () => {
  it("scores a deterministic knowledge-grounded backend end state", () => {
    const fixture = createSierraStyleKnowledgeFixture();
    const backend = new LifeOpsFakeBackend(fixture.world);

    expect(
      scoreSierraStyleKnowledgeFixture(fixture, backend.toDocument()),
    ).toMatchObject({
      pass: false,
      checks: {
        calendarEventCreated: false,
        draftEmailCreated: false,
        reminderCreated: false,
      },
    });

    backend.applyAction("calendar.create_event", {
      calendar_id: "cal_primary",
      title: fixture.requiredEndState.calendarEvent.title,
      start: fixture.requiredEndState.calendarEvent.start,
      end: fixture.requiredEndState.calendarEvent.end,
      attendees: fixture.requiredEndState.calendarEvent.attendees,
    });
    backend.applyAction("mail.create_draft", {
      to_emails: [fixture.requiredEndState.draftEmail.to],
      subject: "Blue Harbor review details",
      body: "Confirming BH-7421 for 15:30 UTC.",
    });
    backend.applyAction("reminders.create", {
      title: fixture.requiredEndState.reminder.title,
      due_at: fixture.requiredEndState.reminder.dueAt,
    });

    expect(
      scoreSierraStyleKnowledgeFixture(fixture, backend.toDocument()),
    ).toEqual({
      pass: true,
      checks: {
        calendarEventCreated: true,
        draftEmailCreated: true,
        reminderCreated: true,
      },
    });
  });

  it("declares voice interruption, noise, dropped-frame, spelling, and pass@1 report requirements", () => {
    const fixture = SIERRA_STYLE_VOICE_INTERRUPTION_FIXTURE;

    expect(fixture.methodology).toEqual({
      inspiration: "sierra_tau_voice",
      dataPolicy: "eliza_owned_synthetic_only",
      sourceData: "none",
    });
    expect(fixture.simulation.turns.some((turn) => turn.interruptionAtMs)).toBe(
      true,
    );
    expect(
      fixture.simulation.turns.some((turn) => turn.background !== "none"),
    ).toBe(true);
    expect(
      fixture.simulation.turns.some(
        (turn) => (turn.droppedFrameWindowsMs?.length ?? 0) > 0,
      ),
    ).toBe(true);
    expect(
      fixture.simulation.authOrSpellingTargets.map((target) => target.kind),
    ).toEqual(["auth_code", "email", "proper_name"]);
    expect(fixture.passCriteria.requiredFailureCategories).toEqual([
      "interruption_recovery",
      "background_noise",
      "dropped_frame",
      "auth_code_spelling",
      "email_spelling",
      "multi_step_completion",
    ]);
  });

  it("validates publishable voice reports include model, voice config, pass@1, categories, and reviewed outputs", () => {
    const fixture = SIERRA_STYLE_VOICE_INTERRUPTION_FIXTURE;
    const passingReport: SierraStyleVoiceReport = {
      provider: "local",
      model: "eliza-1-asr",
      voiceConfig: {
        stt: "fused-local-asr",
        tts: "kokoro",
        vad: "silero",
        noiseProfile: "cafe_babble+keyboard+dropped_frames",
      },
      passAt1: true,
      recoveryCategories: fixture.passCriteria.requiredFailureCategories,
      manuallyReviewedOutputs: [
        ".github/issue-evidence/13361-sierra-style-voice/run-001.json",
      ],
    };

    expect(validateSierraStyleVoiceReport(fixture, passingReport)).toEqual([]);

    expect(
      validateSierraStyleVoiceReport(fixture, {
        ...passingReport,
        provider: "",
        passAt1: false,
        recoveryCategories: ["interruption_recovery"],
        manuallyReviewedOutputs: [],
      }),
    ).toEqual([
      "provider is required",
      "passAt1 must be true for this fixture",
      "missing recovery category: background_noise",
      "missing recovery category: dropped_frame",
      "missing recovery category: auth_code_spelling",
      "missing recovery category: email_spelling",
      "missing recovery category: multi_step_completion",
      "manuallyReviewedOutputs must include at least one artifact",
    ]);
  });
});
