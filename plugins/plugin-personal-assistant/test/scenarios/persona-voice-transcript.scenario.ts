// Defines the persona voice transcript LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { personaDentistFinalChecks } from "./_helpers/persona-dentist-outcome";

/**
 * Persona: voice-transcription-style input — no punctuation, no
 * capitalization, homophone errors from a speech recognizer ("too" for
 * "to", "thirsday" for "Thursday", "tree" for "three", "two" for "too").
 * Same underlying intent and outcome bar as the persona-* siblings — the
 * agent must recover "Thursday 3 PM" from the garbled transcript and still
 * persist the correct once definition plus the day-before reminder.
 */
export default scenario({
  lane: "live-only",
  id: "persona-voice-transcript",
  title: "Persona: voice-transcript homophones still book Thursday 3pm",
  domain: "tasks",
  tags: ["lifeops", "tasks", "persona", "robustness", "voice"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Persona Voice Transcript",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "voice transcript dentist request",
      text: "remind me too call the dentist thirsday at tree pm i mean the appointment is thirsday at tree pm and remind me the day before two",
    },
    {
      kind: "message",
      name: "confirm save",
      text: "yes save that",
    },
  ],
  finalChecks: personaDentistFinalChecks(
    "persona-voice-transcript: reply confirms Thursday 3 PM + day-before reminder despite homophones",
  ),
});
