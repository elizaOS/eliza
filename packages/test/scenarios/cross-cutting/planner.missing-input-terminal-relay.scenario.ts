/**
 * Live-model proof that an owner action's explicit missing-input marker may
 * authorize a clarification or grammar-valid scheduling form.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectMissingInputTerminalRelay } from "./planner.missing-input-terminal-relay.assertion";

export default scenario({
  id: "live-missing-input-terminal-relay",
  lane: "live-only",
  title: "Missing-input reminder clarification reaches the owner",
  domain: "planner-loop",
  tags: ["live", "real-llm", "planner-loop", "lifeops", "15967"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "eliza-app",
      title: "Missing Input Relay",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "missing reminder fields finish as a user-visible interaction",
      room: "main",
      text: "I need a reminder for an upcoming report deadline — ask me for the report name, day, and time before creating anything.",
      assertTurn: expectMissingInputTerminalRelay,
    },
  ],
});
