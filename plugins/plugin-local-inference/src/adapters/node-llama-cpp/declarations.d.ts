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
  const ws: unknown;
  export = ws;
}

// `@huggingface/transformers` is an optional dependency. Same story.
declare module "@huggingface/transformers" {
  const transformers: unknown;
  export = transformers;
}
