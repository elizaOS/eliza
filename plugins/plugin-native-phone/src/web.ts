import { WebPlugin } from "@capacitor/core";

import type {
  CallLogEntry,
  ListRecentCallsOptions,
  PhonePlugin,
  PhoneStatus,
  PlaceCallOptions,
  SaveCallTranscriptOptions,
} from "./definitions";

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateCallTarget(
  options: unknown,
  { requireNumber }: { requireNumber: boolean },
): void {
  if (!isRecord(options)) {
    if (requireNumber) {
      throw new Error("number is required");
    }
    return;
  }
  if (
    (requireNumber && options.number === undefined) ||
    (options.number !== undefined && !nonEmptyString(options.number))
  ) {
    throw new Error("number is required");
  }
}

function validateRecentCallsOptions(options?: ListRecentCallsOptions): void {
  if (options === undefined) {
    return;
  }
  if (!isRecord(options)) {
    throw new Error("options must be an object");
  }
  if (options.limit !== undefined) {
    if (
      typeof options.limit !== "number" ||
      !Number.isFinite(options.limit) ||
      options.limit < 1 ||
      options.limit > 500
    ) {
      throw new Error("limit must be between 1 and 500");
    }
  }
  if (options.number !== undefined && !nonEmptyString(options.number)) {
    throw new Error("number must be a non-empty string");
  }
}

function validateTranscriptOptions(options: SaveCallTranscriptOptions): void {
  if (!isRecord(options) || !nonEmptyString(options.callId)) {
    throw new Error("callId is required");
  }
  if (!nonEmptyString(options.transcript)) {
    throw new Error("transcript is required");
  }
}

export class PhoneWeb extends WebPlugin implements PhonePlugin {
  async getStatus(): Promise<PhoneStatus> {
    return {
      hasTelecom: false,
      canPlaceCalls: false,
      isDefaultDialer: false,
      defaultDialerPackage: null,
    };
  }

  async placeCall(options: PlaceCallOptions): Promise<void> {
    validateCallTarget(options, { requireNumber: true });
    throw new Error("Phone calls are only available on Android.");
  }

  async openDialer(options?: Partial<PlaceCallOptions>): Promise<void> {
    validateCallTarget(options, { requireNumber: false });
    throw new Error("Phone dialer is only available on Android.");
  }

  async listRecentCalls(
    options?: ListRecentCallsOptions,
  ): Promise<{ calls: CallLogEntry[] }> {
    validateRecentCallsOptions(options);
    return { calls: [] };
  }

  async saveCallTranscript(
    options: SaveCallTranscriptOptions,
  ): Promise<{ updatedAt: number }> {
    validateTranscriptOptions(options);
    throw new Error("Call transcripts are only available on Android.");
  }
}
