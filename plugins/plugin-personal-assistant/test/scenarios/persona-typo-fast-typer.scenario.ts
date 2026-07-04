// Defines the persona typo fast typer LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { personaDentistFinalChecks } from "./_helpers/persona-dentist-outcome";

/**
 * Persona: fast typer, heavy typos and abbreviations ("dentst appt thurs
 * 3pm", "b4", "thx"). Same underlying intent and outcome bar as the
 * persona-* siblings — the typos must not corrupt the resolved Thursday
 * 15:00 dueAt or lose the day-before reminder.
 */
export default scenario({
  lane: "live-only",
  id: "persona-typo-fast-typer",
  title: "Persona: typo-heavy fast typer still books Thursday 3pm",
  domain: "tasks",
  tags: ["lifeops", "tasks", "persona", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Persona Typo Fast Typer",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "typo dentist request",
      text: "hey qucik one - dentst appt this thurs 3pm, put it on my scheduel + ping me the day b4 so i dont forget thx",
    },
    {
      kind: "message",
      name: "confirm save",
      text: "yep save it",
    },
  ],
  finalChecks: personaDentistFinalChecks(
    "persona-typo-fast-typer: reply confirms Thursday 3 PM + day-before reminder",
  ),
});
