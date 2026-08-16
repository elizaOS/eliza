/**
 * Normalizes a docker image ref down to its repo, so the fleet upgrade/rollback
 * guard and the reconciler's candidate query treat every tag/digest of the same
 * repo as "the fleet image" and only a genuinely different repo as a custom user
 * image (#15101).
 *
 * A fleet-managed default agent may sit on any tag or digest of the default repo
 * (`ghcr.io/elizaos/eliza:sha-abc`, `…:prod`, `…@sha256:…`); comparing the full
 * ref wrongly classified an older-tagged or digest-pinned default agent as
 * custom and refused/skipped its upgrade. `imageRepo` runs in the guard (JS);
 * `imageRepoSql` is the equivalent Postgres expression that normalizes the
 * stored `docker_image` column inside the candidate query — the two MUST agree,
 * so keep them in lockstep.
 */

import { type Column, type SQL, sql } from "drizzle-orm";

/**
 * Canonical explicit digest pin: `repo[:tag]@sha256:<64 lowercase hex>` with a
 * single `@`. Anything looser (short hex, uppercase, double `@`) is a malformed
 * pseudo-pin and deliberately does NOT earn operator-pin status — it stays an
 * ordinary drift candidate rather than freezing an agent on a typo (#18030).
 * Keep in lockstep with `DIGEST_PINNED_IMAGE_SQL_PATTERN` below.
 */
const DIGEST_PINNED_IMAGE_PATTERN = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

/** Postgres POSIX-regex equivalent of {@link DIGEST_PINNED_IMAGE_PATTERN}. */
const DIGEST_PINNED_IMAGE_SQL_PATTERN = "^[^@[:space:]]+@sha256:[0-9a-f]{64}$";

/** Whether a docker image ref is a canonical explicit `@sha256` digest pin. */
export function isDigestPinnedImage(image: string): boolean {
  return DIGEST_PINNED_IMAGE_PATTERN.test(image.trim());
}

/**
 * The `sha256:<hex>` digest of a canonical digest-pinned ref, or null when the
 * ref is not canonically pinned (including malformed pseudo-pins).
 */
export function pinnedImageDigest(image: string): string | null {
  const trimmed = image.trim();
  if (!DIGEST_PINNED_IMAGE_PATTERN.test(trimmed)) return null;
  return trimmed.slice(trimmed.indexOf("@") + 1);
}

/**
 * Rewrites the digest of a canonical digest-pinned ref so `docker_image` and
 * `image_digest` stay a matched pair across a blue/green swap writeback
 * (#18030). Non-pinned (tag or bare) refs are returned unchanged — their text
 * does not encode a digest, so no rewrite is needed for consistency.
 */
export function repinImageDigest(image: string, digest: string): string {
  const trimmed = image.trim();
  if (!DIGEST_PINNED_IMAGE_PATTERN.test(trimmed)) return image;
  return `${trimmed.slice(0, trimmed.indexOf("@"))}@${digest}`;
}

/**
 * Postgres predicate: the stored ref is a canonical explicit digest pin.
 * Mirrors `isDigestPinnedImage` exactly (whitespace-trimmed, single `@`,
 * 64 lowercase hex) — the two MUST agree.
 */
export function isDigestPinnedImageSql(image: Column | SQL): SQL {
  return sql`(btrim(${image}) ~ ${DIGEST_PINNED_IMAGE_SQL_PATTERN})`;
}

/**
 * Postgres expression yielding the `sha256:<hex>` digest portion of a stored
 * ref. Only meaningful under {@link isDigestPinnedImageSql}; a canonical pin
 * has exactly one `@`, so `split_part(..., '@', 2)` is the full digest.
 */
export function pinnedImageDigestSql(image: Column | SQL): SQL {
  return sql`split_part(btrim(${image}), '@', 2)`;
}

/**
 * The repo portion of a docker image ref (strips the `:tag` / `@digest`).
 *
 * A tag is the segment after the LAST `:` only when it has no `/` after it, so a
 * registry port (`ghcr.io:443/…`) is not mistaken for a tag.
 */
export function imageRepo(image: string): string {
  const atIdx = image.indexOf("@");
  const base = atIdx === -1 ? image : image.slice(0, atIdx);
  const lastColon = base.lastIndexOf(":");
  const lastSlash = base.lastIndexOf("/");
  return lastColon > lastSlash ? base.slice(0, lastColon) : base;
}

/**
 * Postgres expression yielding the repo portion of a `docker_image` column,
 * mirroring `imageRepo` exactly: strip any `@digest`, then strip a trailing
 * `:tag` only when its colon follows the last `/` (preserving a registry port).
 *
 * `strpos(reverse(x), c)` gives the 1-based offset of the LAST `c` (0 when
 * absent); a colon that ranks after the last slash is a tag, so it is dropped.
 * When neither is present both offsets are 0 and the base is kept unchanged.
 */
export function imageRepoSql(image: Column | SQL): SQL {
  const base = sql`split_part(${image}, '@', 1)`;
  const lastColon = sql`(CASE WHEN strpos(reverse(${base}), ':') = 0 THEN 0 ELSE length(${base}) - strpos(reverse(${base}), ':') + 1 END)`;
  const lastSlash = sql`(CASE WHEN strpos(reverse(${base}), '/') = 0 THEN 0 ELSE length(${base}) - strpos(reverse(${base}), '/') + 1 END)`;
  return sql`(CASE WHEN ${lastColon} > ${lastSlash} THEN left(${base}, ${lastColon} - 1) ELSE ${base} END)`;
}
