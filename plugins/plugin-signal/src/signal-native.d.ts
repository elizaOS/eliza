declare module "@elizaos/signal-native" {
  export interface SignalNativeProfile {
    uuid: string;
    phoneNumber?: string | null;
  }

  export function linkDevice(authDir: string, deviceName: string): Promise<string>;

  export function finishLink(authDir: string): Promise<void>;

  export function getProfile(authDir: string): Promise<SignalNativeProfile>;
}
