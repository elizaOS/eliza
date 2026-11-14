/**
 * Upload bytes to the Worker R2 binding and return a public HTTPS URL.
 * The host is R2_PUBLIC_HOST; only the Eliza deployment has a default.
 */

import type { Bindings } from "../../types/cloud-worker-env";
import { resolveCloudBlobHost } from "../deployment/cloud-deployment";

export type PublicObjectBindings = Pick<Bindings, "BLOB" | "R2_PUBLIC_HOST">;

export interface PutPublicObjectOptions {
  /** R2 object key (no leading slash). */
  key: string;
  body: ArrayBuffer | ArrayBufferView;
  contentType: string;
  customMetadata?: Record<string, string>;
}

export function publicUrlForR2Key(env: PublicObjectBindings, key: string): string {
  const host = resolveCloudBlobHost(env);
  return `https://${host}/${key}`;
}

export async function putPublicObject(
  env: PublicObjectBindings,
  opts: PutPublicObjectOptions,
): Promise<{ url: string; key: string }> {
  const url = publicUrlForR2Key(env, opts.key);
  await env.BLOB.put(opts.key, opts.body, {
    httpMetadata: { contentType: opts.contentType },
    customMetadata: opts.customMetadata,
  });
  return { key: opts.key, url };
}
