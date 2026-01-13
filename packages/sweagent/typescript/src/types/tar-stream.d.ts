declare module 'tar-stream' {
  /**
   * Create a tar pack stream
   * @returns A writable stream for creating tar archives
   */
  export function pack(): NodeJS.WritableStream;

  /**
   * Create a tar extract stream
   * @returns A writable stream for extracting tar archives
   */
  export function extract(): NodeJS.WritableStream;
}
