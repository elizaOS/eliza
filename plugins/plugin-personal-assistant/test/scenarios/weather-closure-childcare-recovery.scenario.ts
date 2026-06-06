import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "weather-closure-childcare-recovery",
  title: "Assistant recovers childcare after a weather closure",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "schedule", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Weather Closure Childcare Recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-weather-closure-plan",
      text: "School closed for weather. Find backup childcare, carpool changes, my immovable meetings, partner availability, and who needs an update.",
      plannerIncludesAny: ["calendar_action", "owner_send_message", "priority"],
      responseIncludesAny: ["backup childcare", "carpool", "meetings", "update"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-family-updates",
      text: "Draft updates to the nanny, carpool parent, and my EA. Ask before canceling any meeting or confirming paid backup care.",
      plannerIncludesAny: ["owner_send_message", "approval", "SCHEDULED_TASKS"],
      responseIncludesAny: ["nanny", "carpool", "canceling", "backup care"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
