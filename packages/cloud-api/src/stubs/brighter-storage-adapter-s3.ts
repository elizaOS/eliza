const notConfigured =
  "@brighter/storage-adapter-s3 is stubbed in the Cloudflare Worker bundle. Configure the native R2 binding or S3 route adapter before using this path.";

function unavailable(): never {
  throw new Error(notConfigured);
}

export function Storage() {
  return {
    write: unavailable,
    read: unavailable,
    stat: unavailable,
    exists: unavailable,
    remove: unavailable,
    list: unavailable,
    presign: unavailable,
  };
}
