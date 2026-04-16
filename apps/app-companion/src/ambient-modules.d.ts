declare module "*.svg" {
  const src: string;
  export default src;
}

/** Pulled in when typechecking agent sources that lazy-load this plugin. */
declare module "@elizaos/plugin-pi-ai";

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
