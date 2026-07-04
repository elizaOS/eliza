/**
 * Live-model scenario: the assistant turns polite right-to-left Arabic phrasing into a daily tooth-brushing habit (8am / 9pm reminders), confirming across a preview then a save turn.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "brush-teeth-arabic",
  title: "Brush teeth from polite Arabic phrasing (RTL)",
  domain: "tasks",
  tags: ["lifeops", "tasks", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "whatsapp",
      title: "LifeOps Brush Teeth Arabic",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth arabic preview",
      text: "هل يمكنك تذكيري بتنظيف أسناني في الساعة 8 صباحًا و9 مساءً كل يوم؟",
      responseIncludesAny: [
        "brush teeth",
        "brushing habit",
        "set that up",
        "تنظيف",
        "أسنان",
        "تذكير",
      ],
    },
    {
      kind: "message",
      name: "brush-teeth arabic confirm",
      text: "نعم، من فضلك احفظ روتين تنظيف الأسنان هذا.",
      responseIncludesAny: ["saved", "brush", "teeth", "حفظ", "أسنان"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: [
        "تنظيف الأسنان",
        "تنظيف أسناني",
        "روتين تنظيف الأسنان",
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
