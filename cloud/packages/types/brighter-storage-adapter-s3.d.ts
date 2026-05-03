/**
 * Module-shape declaration for `@brighter/storage-adapter-s3`.
 *
 * The upstream package ships JS-only (no .d.ts). The actual runtime surface
 * is wider, but this repo only consumes the `Storage` factory through the
 * strictly-typed wrapper in `@/lib/services/storage/r2-storage-adapter.ts`,
 * so the shim only needs to expose the factory's call signature.
 *
 * Treat this declaration as the source of truth: every call into brighter
 * must go through `R2StorageAdapter`, never directly.
 */
declare module "@brighter/storage-adapter-s3" {
  export interface BrighterS3Config {
    type: "s3";
    path: string;
  }

  export interface BrighterS3ClientOptions {
    region?: string;
    endpoint?: string;
    credentials?: { accessKeyId: string; secretAccessKey: string };
    forcePathStyle?: boolean;
  }

  export interface BrighterS3StorageInstance {
    read(path: string, opts?: { encoding?: string }): Promise<string | Buffer>;
    write(path: string, data: Buffer | string, opts?: { encoding?: string }): Promise<void>;
    remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
    exists(path: string): Promise<boolean>;
    list(
      path: string,
      opts?: { recursive?: boolean; absolute?: boolean },
    ): Promise<Array<string>>;
    stat(path: string): Promise<{
      file: string;
      contentType: string;
      etag: string;
      size: number;
      modified: Date;
      url: string;
    }>;
    presign(path: string, opts?: { expiresIn?: number }): Promise<string>;
  }

  export function Storage(
    config: BrighterS3Config,
    client: BrighterS3ClientOptions,
  ): BrighterS3StorageInstance;
}
