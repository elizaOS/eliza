declare module 'stream-browserify' {
  import { PassThrough as NodePassThrough, Readable as NodeReadable } from 'stream';

  interface StreamBrowserify {
    PassThrough: typeof NodePassThrough;
    Readable: typeof NodeReadable;
    // Add other properties as needed
  }

  const pkg: StreamBrowserify;
  export = pkg;
}
