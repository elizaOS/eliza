/**
 * Live-model smoke scenario: polite Japanese (です/ます) phrasing yields a daily 8am/9pm brushing habit save.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "brush-teeth-japanese",
  title: "Brush teeth from polite Japanese (です/ます) phrasing",
  domain: "tasks",
  tags: ["lifeops", "tasks", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Brush Teeth Japanese",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth japanese preview",
      text: "毎日朝8時と夜9時に歯磨きするのを手伝ってもらえますか。",
      responseIncludesAny: [
        "brush teeth",
        "brushing habit",
        "set that up",
        "歯磨き",
        "歯を磨く",
      ],
    },
    {
      kind: "message",
      name: "brush-teeth japanese confirm",
      text: "はい、その歯磨きの習慣を保存してください。",
      responseIncludesAny: ["saved", "brush", "teeth", "歯磨き", "保存"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: [
        "Brush Teeth 8 + 9 Pm",
        "Brush teeth 8 + 9 pm",
        "Brush teeth 8 am & 9 pm",
        "歯磨き",
        "歯みがき",
        "歯を磨く",
      ],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      requireReminderPlan: true,
    },
  ],
});
