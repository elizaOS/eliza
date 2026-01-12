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
