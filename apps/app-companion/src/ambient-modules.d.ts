declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "@elizaos/signal-native" {
  export function linkDevice(
    authDir: string,
    deviceName: string,
  ): Promise<string>;
  export function finishLink(authDir: string): Promise<void>;
  export function getProfile(authDir: string): Promise<{
    uuid: string;
    phoneNumber?: string | null;
  }>;
}
