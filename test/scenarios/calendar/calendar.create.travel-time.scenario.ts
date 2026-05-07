import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "calendar.create.travel-time",
  title: "Create a calendar event with travel-time awareness",
  domain: "calendar",
  tags: ["lifeops", "calendar", "travel", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Create With Travel Time",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-event-with-travel-time",
      text: "Book a lunch with Alex at Tartine tomorrow at noon. Block travel time from my house.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "travel-time-aware calendar creation",
      }),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "calendar-create-travel-buffer-result",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "CALENDAR",
        );
        if (!hit) {
          return "expected CALENDAR_ACTION result";
        }
        const data = (hit.result?.data ?? {}) as {
          location?: string;
          travelOriginAddress?: string;
          travelDestinationAddress?: string;
          travelBufferMinutes?: number;
          travelBufferMethod?: string;
          travelTime?: {
            originAddress?: string | null;
            destinationAddress?: string | null;
            bufferMinutes?: number;
            method?: string;
          };
        };
        if (
          typeof data.travelOriginAddress !== "string" ||
          data.travelOriginAddress.trim().length === 0
        ) {
          return "expected travelOriginAddress in calendar create result payload";
        }
        if (
          typeof data.location !== "string" ||
          data.location.trim().length === 0
        ) {
          return "expected created calendar event location in result payload";
        }
        if (data.travelDestinationAddress !== data.location) {
          return "expected travelDestinationAddress to match the created event location";
        }
        if (
          typeof data.travelBufferMinutes !== "number" ||
          data.travelBufferMinutes < 1
        ) {
          return "expected positive travelBufferMinutes in calendar create result payload";
        }
        if (data.travelTime?.bufferMinutes !== data.travelBufferMinutes) {
          return "expected travelTime.bufferMinutes to match travelBufferMinutes";
        }
        if (data.travelTime?.originAddress !== data.travelOriginAddress) {
          return "expected travelTime.originAddress to match travelOriginAddress";
        }
        if (data.travelTime?.method !== data.travelBufferMethod) {
          return "expected travelTime.method to match travelBufferMethod";
        }
        return undefined;
      },
    },
    {
      type: "custom",
      name: "calendar-create-travel-action-covered",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "travel-time-aware calendar creation",
      }),
    },
  ],
});
