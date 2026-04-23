import { WebPlugin } from "@capacitor/core";

import type { PhonePlugin, PhoneStatus, PlaceCallOptions } from "./definitions";

export class PhoneWeb extends WebPlugin implements PhonePlugin {
  async getStatus(): Promise<PhoneStatus> {
    return {
      hasTelecom: false,
      canPlaceCalls: false,
      defaultDialerPackage: null,
    };
  }

  async placeCall(_options: PlaceCallOptions): Promise<void> {
    throw new Error("Phone calls are only available on Android.");
  }

  async openDialer(_options?: Partial<PlaceCallOptions>): Promise<void> {
    throw new Error("Phone dialer is only available on Android.");
  }
}
