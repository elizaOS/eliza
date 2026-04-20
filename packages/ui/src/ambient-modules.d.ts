declare module "@elizaos/signal-native";

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
    decodeGltfBuffer(
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode: string,
      filter?: string,
    ): void;
    useWorkers?(count: number): void;
  };
}

declare module "jsdom" {
  export class JSDOM {
    constructor(
      html?: string,
      options?: {
        url?: string;
        pretendToBeVisual?: boolean;
        [key: string]: unknown;
      },
    );
    window: Window & typeof globalThis;
    serialize(): string;
  }
}
