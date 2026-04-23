export interface PlaceCallOptions {
  number: string;
}

export interface PhoneStatus {
  hasTelecom: boolean;
  canPlaceCalls: boolean;
  defaultDialerPackage: string | null;
}

export interface PhonePlugin {
  getStatus(): Promise<PhoneStatus>;
  placeCall(options: PlaceCallOptions): Promise<void>;
  openDialer(options?: Partial<PlaceCallOptions>): Promise<void>;
}
