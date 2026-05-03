declare module "music-metadata" {
  export function parseBuffer(
    buffer: Buffer | Uint8Array,
    options?: { mimeType?: string; size?: number; duration?: boolean },
  ): Promise<{
    format?: { duration?: number; container?: string };
    common?: { title?: string; artist?: string };
    [key: string]: unknown;
  }>;
}
