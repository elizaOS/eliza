/**
 * Upload bytes to the Worker R2 binding and return a public HTTPS URL.
 * Mirrors the voice-clone sample pattern (blob.eliza.app or R2_PUBLIC_HOST).
 */

import type { Bindings } from "../../types/cloud-worker-env";

const DEFAULT_R2_PUBLIC_HOST = "blob.eliza.app";

export type PublicObjectBindings = Pick<Bindings, "BLOB" | "R2_PUBLIC_HOST">;

export interface PutPublicObjectOptions {
  /** R2 object key (no leading slash). */
  key: string;
  body: ArrayBuffer | ArrayBufferView;
  contentType: string;
  customMetadata?: Record<string, string>;
}

export function publicUrlForR2Key(env: PublicObjectBindings, key: string): string {
  const host =
    typeof env.R2_PUBLIC_HOST === "string" && env.R2_PUBLIC_HOST.length > 0
      ? env.R2_PUBLIC_HOST
      : DEFAULT_R2_PUBLIC_HOST;
  return `https://${host}/${key}`;
}

export async function putPublicObject(
  env: PublicObjectBindings,
  opts: PutPublicObjectOptions,
): Promise<{ url: string; key: string }> {
  await env.BLOB.put(opts.key, opts.body, {
    httpMetadata: { contentType: opts.contentType },
    customMetadata: opts.customMetadata,
  });
  return { key: opts.key, url: publicUrlForR2Key(env, opts.key) };
}
