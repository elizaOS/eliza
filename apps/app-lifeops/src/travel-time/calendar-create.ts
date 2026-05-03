import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  type CalendarEventLookupLike,
  type TravelBufferResult,
  TravelTimeService,
} from "./service.js";

export type CreateEventTravelIntent = {
  originAddress: string;
};

function readString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function resolveCreateEventTravelIntent(args: {
  details: Record<string, unknown> | undefined;
  extractedDetails: Record<string, unknown>;
}): CreateEventTravelIntent | null {
  const originAddress =
    readString(args.extractedDetails, "travelOriginAddress") ??
    readString(args.details, "travelOriginAddress");
  if (!originAddress) {
    return null;
  }
  return { originAddress };
}

export async function computeCreateEventTravelBuffer(args: {
  runtime: IAgentRuntime;
  calendar: CalendarEventLookupLike;
  event: Pick<LifeOpsCalendarEvent, "id" | "location">;
  travelIntent: CreateEventTravelIntent;
}): Promise<TravelBufferResult> {
  const service = new TravelTimeService(args.runtime, {
    calendar: args.calendar,
  });
  return service.computeBufferForEvent(
    args.event,
    args.travelIntent.originAddress,
  );
}
