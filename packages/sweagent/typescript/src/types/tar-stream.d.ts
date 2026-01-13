declare module "tar-stream" {
  /**
   * Create a tar pack stream
   * @returns A pack stream for creating tar archives
   */
  export interface Pack extends NodeJS.ReadWriteStream {
    entry(
      header: { name: string },
      content: Buffer | string,
      callback?: (err?: Error) => void,
    ): void;
    finalize(): void;
  }

  export function pack(): Pack;

  /**
   * Create a tar extract stream
   * @returns A writable stream for extracting tar archives
   */
  export function extract(): NodeJS.WritableStream;
}
