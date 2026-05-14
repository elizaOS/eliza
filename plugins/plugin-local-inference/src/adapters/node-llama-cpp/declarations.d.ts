declare module "stream-browserify" {
  import {
    PassThrough as NodePassThrough,
    Readable as NodeReadable,
    Transform as NodeTransform,
  } from "node:stream";

  interface StreamBrowserify {
    PassThrough: typeof NodePassThrough;
    Readable: typeof NodeReadable;
    Transform: typeof NodeTransform;
  }

  const pkg: StreamBrowserify;
  export = pkg;
}

// `ws` is an optional native dependency only resolved at runtime via dynamic
// import. The tsup build marks it `--external`, so the compiler never sees the
// real types. Declare a loose surface so callers can type-check.
declare module "ws" {
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  export const WebSocket: any;
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  export const WebSocketServer: any;
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  export type WebSocket = any;
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  export type WebSocketServer = any;
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  const ws: any;
  export default ws;
}

// `@huggingface/transformers` is an optional dependency. Same story.
declare module "@huggingface/transformers" {
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  export const AutoTokenizer: any;
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  export const AutoModelForSequenceClassification: any;
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  export const pipeline: any;
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  export type TextToAudioPipeline = any;
  // biome-ignore lint/suspicious/noExplicitAny: loose ambient stub for an optional dep
  const transformers: any;
  export default transformers;
}
