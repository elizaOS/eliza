import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "brush-teeth-smalltalk-preference",
  title: "Brush teeth from smalltalk into preference update",
  domain: "tasks",
  tags: ["lifeops", "tasks"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Brush Teeth Smalltalk",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "smalltalk warmup",
      text: "hey, mornings have been a little chaotic lately.",
    },
    {
      kind: "message",
      name: "smalltalk context",
      text: "the main thing i keep forgetting is brushing my teeth before i start working.",
    },
    {
      kind: "message",
      name: "brush-teeth create from context",
      text: "Please make that into a routine named Brush teeth with reminders around 8am and 9pm. Just preview the plan for now and do not save it yet.",
      responseJudge: {
        rubric:
          "The assistant should treat this as a preview-only step for the Brush teeth routine, not as a saved result. A passing reply keeps the routine/reminder setup in substance, makes clear the user can review, tweak, or confirm it, and does not pretend the routine is already active.",
      },
    },
    {
      kind: "message",
      name: "brush-teeth confirm",
      text: "That looks right. Save the Brush teeth routine.",
      responseJudge: {
        rubric:
          "The assistant should confirm that the Brush teeth routine is now created and active with the requested morning and night reminders. A passing reply may say the routine was saved, set up, scheduled, or is now in place, but it should not ask for confirmation again or imply the routine is still only a draft.",
      },
      waitForDefinitionTitle: "Brush teeth",
      waitForDefinitionTitleAliases: [
        "Brush teeth 8 + 9 pm",
        "Brush teeth 8 am & 9 pm",
      ],
    },
    {
      kind: "message",
      name: "brush-teeth reduce reminders",
      text: "Now turn the Brush teeth reminder intensity down to minimal.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Brush teeth 8 + 9 pm", "Brush teeth 8 am & 9 pm"],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      requireReminderPlan: true,
    },
    {
      type: "reminderIntensity",
      title: "Brush teeth",
      expected: "minimal",
    },
  ],
});
