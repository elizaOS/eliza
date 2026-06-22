import { scenario } from "@elizaos/scenario-runner/schema";
import { runMultiTaskSupervisorCheck } from "./_helpers/supervisor-scenario.ts";

// Two concurrent tasks in one room and a third in another exercise the
// multi-task juggler (#8932): each room gets its own digest (isolation),
// terminal / chat-less tasks are excluded, an unchanged tick is deduped, and a
// changed tick re-posts only the affected room. The supervisor digest functions
// are pure, so this runs in the keyless `pr-deterministic` lane — no model, no
// sub-agent subprocess. The assertion logic is shared with, and verified by,
// `orchestrator-scenario-logic.test.ts`.
export default scenario({
  lane: "pr-deterministic",
  id: "orchestrator.multi-task-supervisor",
  title: "Multi-task supervisor: per-room isolation + change-driven digest",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "multi-task", "supervisor", "deterministic"],
  description:
    "Two concurrent tasks in one room and a third in another exercise the multi-task juggler: each room gets its own digest (isolation), terminal/chat-less tasks are excluded, an unchanged tick is deduped, and a changed tick re-posts only the affected room.",
  turns: [],
  finalChecks: [
    {
      type: "custom",
      name: "multi-task-supervisor-isolation-and-digest",
      predicate: () => runMultiTaskSupervisorCheck(),
    },
  ],
});
