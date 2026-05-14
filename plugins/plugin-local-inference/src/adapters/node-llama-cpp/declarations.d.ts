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

// `@elizaos/plugin-computeruse`'s dist `.d.ts` is currently incomplete (it
// re-exports modules whose sub-files were not generated). Declare a loose
// surface for the few iOS-bridge types this plugin imports so callers can
// type-check without depending on the full dist of plugin-computeruse.
declare module "@elizaos/plugin-computeruse" {
  // biome-ignore-start lint/suspicious/noExplicitAny: loose ambient stubs for an optional dep
  export type FoundationModelOptions = any;
  export type FoundationModelResult = any;
  export type IosComputerUseBridge = any;
  // biome-ignore-end lint/suspicious/noExplicitAny: loose ambient stubs for an optional dep
}

// `@huggingface/transformers` is an optional dependency. Same story. The
// upstream package's `types/transformers.d.ts` is missing from the published
// tarball, so this ambient module fills in the slot.
declare module "@huggingface/transformers" {
  // biome-ignore-start lint/suspicious/noExplicitAny: loose ambient stubs for an optional dep
  export const AutoTokenizer: any;
  export const AutoProcessor: any;
  export const AutoModelForSequenceClassification: any;
  export type Florence2ForConditionalGeneration = any;
  export const Florence2ForConditionalGeneration: any;
  export type Florence2Processor = any;
  export const Florence2Processor: any;
  export const RawImage: any;
  export const pipeline: any;
  export const env: any;
  export type PreTrainedTokenizer = any;
  export type ProgressCallback = any;
  export type ProgressInfo = any;
  export type Tensor = any;
  export type TextToAudioPipeline = any;
  const transformers: any;
  export default transformers;
  // biome-ignore-end lint/suspicious/noExplicitAny: loose ambient stubs for an optional dep
}
