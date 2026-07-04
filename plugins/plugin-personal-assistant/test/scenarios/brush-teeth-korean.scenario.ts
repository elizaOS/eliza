/**
 * Live-model smoke scenario: polite Korean phrasing yields a daily 8am/9pm brushing habit save.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "brush-teeth-korean",
  title: "Brush teeth from polite Korean phrasing",
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
      title: "LifeOps Brush Teeth Korean",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth korean preview",
      text: "매일 아침 8시랑 저녁 9시에 양치하라고 알려주세요.",
      responseIncludesAny: [
        "brush teeth",
        "brushing habit",
        "set that up",
        "양치",
        "이 닦",
        "알림",
      ],
    },
    {
      kind: "message",
      name: "brush-teeth korean confirm",
      text: "네, 그 양치 루틴 저장해 주세요.",
      responseIncludesAny: ["saved", "brush", "teeth", "저장", "양치"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: [
        "양치",
        "양치하기",
        "양치 루틴",
        "Brush Teeth 8 + 9 Pm",
        "Brush teeth 8 + 9 pm",
        "Brush teeth 8 am & 9 pm",
      ],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      requireReminderPlan: true,
    },
  ],
});
