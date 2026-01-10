declare module 'stream-browserify' {
  import {
    PassThrough as NodePassThrough,
    Readable as NodeReadable,
    Transform as NodeTransform,
  } from 'stream';

  interface StreamBrowserify {
    PassThrough: typeof NodePassThrough;
    Readable: typeof NodeReadable;
    Transform: typeof NodeTransform;
    // Add other properties as needed
  }

  const pkg: StreamBrowserify;
  export = pkg;
}
