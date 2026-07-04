// Defines the persona esl grammar LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { personaDentistFinalChecks } from "./_helpers/persona-dentist-outcome";

/**
 * Persona: ESL speaker with systematic grammar errors (article drops, wrong
 * prepositions, "please to" constructions). Same underlying intent and
 * outcome bar as the persona-* siblings — the grammar noise must not change
 * the resolved Thursday 15:00 dueAt or drop the day-before reminder.
 */
export default scenario({
  lane: "live-only",
  id: "persona-esl-grammar",
  title: "Persona: ESL grammar errors still book Thursday 3pm",
  domain: "tasks",
  tags: ["lifeops", "tasks", "persona", "robustness", "multilingual"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Persona ESL Grammar",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "esl dentist request",
      text: "Hello, I am needing help for remember dentist appointment. Appointment is in Thursday 3pm this week. Please also remind to me one day before of appointment so I no forget. Is possible?",
    },
    {
      kind: "message",
      name: "confirm save",
      text: "Yes, is correct. Please to save it.",
    },
  ],
  finalChecks: personaDentistFinalChecks(
    "persona-esl-grammar: reply confirms Thursday 3 PM + day-before reminder",
  ),
});
