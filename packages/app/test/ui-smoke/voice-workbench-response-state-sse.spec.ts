/**
 * Voice Workbench — response-state SSE browser wiring (#8785). The mocked agent
 * stream mixes token/done replies with `noResponseReason: "ignored"` done
 * events so the client can prove response/no-response state propagation.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-response-state-sse.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "respond-decision-mix",
  description: "Mock SSE replies and no-response events map to client state.",
  classes: ["response-state-sse"],
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
