/**
 * Voice Workbench — respond / no-respond scenario class (#8785). Mixes turns the
 * agent should answer with turns it should ignore (background chatter). The
 * player scores each turn's respond decision against ground truth — a real
 * `noResponseReason: "ignored"` resolves the reply text to "" (no response).
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-respond-no-respond.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "respond-decision-mix",
  description: "Directed questions get a reply; overheard chatter does not.",
  classes: ["respond-no-respond"],
  participants: [{ label: "owner", isOwner: true }, { label: "bystander" }],
  turns: [
    {
      speaker: "owner",
      text: "hey eliza what is on my calendar",
      expectRespond: true,
    },
    {
      speaker: "bystander",
      text: "did you see the game last night",
      expectRespond: false,
    },
    { speaker: "owner", text: "ok thanks", expectRespond: true },
    {
      speaker: "bystander",
      text: "anyway lets get lunch",
      expectRespond: false,
    },
  ],
});
