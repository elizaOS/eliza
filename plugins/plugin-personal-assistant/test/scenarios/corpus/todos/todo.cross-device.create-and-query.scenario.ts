/** Scenario fixture for todo cross device create and query; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "todo.cross-device.create-and-query",
  title:
    "Create a todo on the dashboard, confirm it, then query it from mobile",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Todos Cross-Device Main",
    },
    {
      id: "mobile",
      source: "telegram",
      title: "LifeOps Todos Cross-Device Mobile",
    },
  ],
  // Seeded-token grounding (#9310): "Alverstone" exists only in this seed —
  // no user turn contains it — so the mobile list read-back can only surface
  // it by actually reading the todo store.
  seed: [
    {
      type: "todo",
      name: "Renew Alverstone parking permit",
      priority: 3,
      dueIso: "{{now+5h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-on-dashboard",
      room: "main",
      text: "Create a todo: pick up dry cleaning tomorrow.",
      expectedActions: ["LIFE"],
      // Two-phase commit (#9310): the old keywords were echoes of this turn's
      // own text. The preview must not claim persistence before the owner
      // confirms; definitionCountDelta stays load-bearing.
      responseExcludes: ["saved", "all set", "i've added", "i've created"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a one-off dry-cleaning pickup todo due tomorrow and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no concrete proposal, fails.",
      },
    },
    {
      kind: "message",
      name: "confirm-on-dashboard",
      room: "main",
      text: "Yes, save it.",
      expectedActions: ["LIFE"],
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "added", "scheduled", "set up"],
    },
    {
      kind: "message",
      name: "query-on-mobile",
      room: "mobile",
      text: "What's on my todo list?",
      // Cross-device read-back: the list from the mobile room must surface
      // both the todo created on the dashboard AND the seeded todo whose
      // distinctive token appears in no user turn.
      responseIncludesAll: ["dry cleaning", "Alverstone"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "LIFE",
      status: "success",
      minCount: 3,
    },
    {
      type: "definitionCountDelta",
      title: "Pick up dry cleaning",
      titleAliases: [
        "pick up dry cleaning",
        "Pick up dry cleaning tomorrow",
        "Dry cleaning",
      ],
      delta: 1,
      cadenceKind: "once",
    },
  ],
});
