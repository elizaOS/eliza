// Defines the persona elderly nontechnical LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { personaDentistFinalChecks } from "./_helpers/persona-dentist-outcome";

/**
 * Persona: elderly, non-technical owner. Rambling, apologetic phrasing, no
 * tech vocabulary, the actual task buried mid-paragraph. Same underlying
 * intent as every persona-* sibling — "dentist appointment Thursday 3pm +
 * remind me the day before" — and the same outcome bar (see
 * `_helpers/persona-dentist-outcome.ts`): a persisted once definition whose
 * resolved dueAt is Thursday 15:00 in the owner timezone, a materialized
 * day-before reminder, and a judged reply that confirms the resolved
 * day/time instead of parroting the input.
 */
export default scenario({
  lane: "live-only",
  id: "persona-elderly-nontechnical",
  title: "Persona: elderly non-technical phrasing still books Thursday 3pm",
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
      title: "Persona Elderly Non-Technical",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "rambling dentist request",
      text: "Hello dear, I hope I am doing this right, my daughter set this up for me and I don't really understand these phone things. My tooth has been bothering me again and the nice lady at the office said the dentist can see me this Thursday at 3 in the afternoon, the office over on Maple Street. Could you please make sure I don't forget the appointment? And could you also tell me about it the day before, so I have time to arrange the bus? Thank you kindly.",
    },
    {
      kind: "message",
      name: "confirm save",
      text: "Yes please, save that for me, dear. Thank you.",
    },
  ],
  finalChecks: personaDentistFinalChecks(
    "persona-elderly-nontechnical: reply confirms Thursday 3 PM + day-before reminder",
  ),
});
