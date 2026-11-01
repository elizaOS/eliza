/** Exact-input positive TTS safety receipts; never caches skipped or failed review. */
import { createHash } from "node:crypto";
import type { KvNamespaceLike } from "../cache/adapters/kv-cache-adapter";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";
import { type ContentSafetyInput, contentSafetyService } from "./content-safety";

const TTL_MS = 60_000;
const LIMIT = 256;
const accepted = new Map<string, number>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function assertSafeTtsText(
  input: ContentSafetyInput,
  defer?: (task: Promise<unknown>) => void,
): Promise<"reviewed" | "approved-hit" | undefined> {
  const env = getCloudAwareEnv();
  // The public TTS route is text-only. A mutable image URL is not an immutable
  // review input and must never reuse a text safety receipt.
  if (input.imageUrls?.length) {
    await contentSafetyService.assertSafeForPublicUse(input);
    return undefined;
  }
  // Model, enforcement mode, failure policy, credential rotation and the
  // complete tenant/text/context are part of the receipt identity. Neither
  // raw text nor provider credentials are stored in the cache.
  const key = `tts-safety:v1:${hash(
    JSON.stringify({
      model: env.OPENAI_MODERATION_MODEL || "omni-moderation-latest",
      policy: env.CONTENT_SAFETY_POLICY_REVISION || "tts-text-v1",
      mode: env.CONTENT_SAFETY_MODE || "enforce",
      failOpen: env.CONTENT_SAFETY_FAIL_OPEN || "false",
      requireConfigured: env.CONTENT_SAFETY_REQUIRE_CONFIG || "false",
      credential: hash(env.OPENAI_MODERATION_API_KEY || env.OPENAI_API_KEY || ""),
      input,
    }),
  )}`;
  const now = Date.now();
  if ((accepted.get(key) ?? 0) > now) return "approved-hit";
  accepted.delete(key);
  const kv = getCloudBinding<KvNamespaceLike>("CACHE_KV");
  if (kv) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        kv.get(key),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), 100);
        }),
      ]);
      const receipt = raw ? JSON.parse(raw) : null;
      if (
        receipt?.version === 1 &&
        Number.isFinite(receipt.expiresAt) &&
        receipt.expiresAt > now &&
        receipt.expiresAt <= now + TTL_MS
      ) {
        remember(key, receipt.expiresAt);
        return "approved-hit";
      }
    } catch {
      /* A missing cache receipt still requires the ordinary review. */
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  const review = await contentSafetyService.assertSafeForPublicUse(input);
  if (
    review.allowed &&
    !review.skipped &&
    !review.flagged &&
    review.mode === "enforce" &&
    !review.issues.length
  ) {
    const expiresAt = Date.now() + TTL_MS;
    remember(key, expiresAt);
    if (kv) {
      const write = kv
        .put(key, JSON.stringify({ version: 1, expiresAt }), { expirationTtl: 60 })
        .catch(() => {
          /* Cache writes cannot change a safety decision. */
        });
      if (defer) defer(write);
      else await write;
    }
    return "reviewed";
  }
  return undefined;
}

function remember(key: string, expiresAt: number) {
  accepted.delete(key);
  accepted.set(key, expiresAt);
  while (accepted.size > LIMIT) accepted.delete(accepted.keys().next().value!);
}
