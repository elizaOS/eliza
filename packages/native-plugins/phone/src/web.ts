import { WebPlugin } from "@capacitor/core";

import type {
  CallLogEntry,
  ListRecentCallsOptions,
  PhonePlugin,
  PhoneStatus,
  PlaceCallOptions,
  SaveCallTranscriptOptions,
} from "./definitions";

export class PhoneWeb extends WebPlugin implements PhonePlugin {
  async getStatus(): Promise<PhoneStatus> {
    return {
      hasTelecom: false,
      canPlaceCalls: false,
      isDefaultDialer: false,
      defaultDialerPackage: null,
    };
  }

  async placeCall(_options: PlaceCallOptions): Promise<void> {
    throw new Error("Phone calls are only available on Android.");
  }

  async openDialer(_options?: Partial<PlaceCallOptions>): Promise<void> {
    throw new Error("Phone dialer is only available on Android.");
  }

  async listRecentCalls(
    _options?: ListRecentCallsOptions,
  ): Promise<{ calls: CallLogEntry[] }> {
    return { calls: [] };
  }

  async saveCallTranscript(
    _options: SaveCallTranscriptOptions,
  ): Promise<{ updatedAt: number }> {
    throw new Error("Call transcripts are only available on Android.");
  }
}
