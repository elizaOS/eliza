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

declare module "three/examples/jsm/libs/meshopt_decoder.module.js" {
  export const MeshoptDecoder: {
    supported: boolean;
    ready: Promise<void>;
    decode(
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode?: number,
    ): void;
    decodeGltfBuffer?(
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode: string,
      filter: string,
    ): void;
  };
}
