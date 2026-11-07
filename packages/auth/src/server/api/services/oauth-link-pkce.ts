import { createHash, timingSafeEqual } from "node:crypto";

/** Legacy confidential clients may omit PKCE; supplied bindings must use S256. */
export function validOAuthLinkPkce(
  challenge: unknown,
  method: unknown,
): boolean {
  if (challenge === undefined && method === undefined) return true;
  return (
    typeof challenge === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(challenge) &&
    method === "S256"
  );
}

/** Verify the stored binding before any provider exchange or account mutation. */
export function matchesOAuthLinkPkce(
  challenge: unknown,
  method: unknown,
  verifier: unknown,
): boolean {
  if (!validOAuthLinkPkce(challenge, method)) return false;
  if (challenge === undefined) return verifier === "" || verifier === undefined;
  if (
    typeof verifier !== "string" ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
  )
    return false;
  const computed = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(challenge as string),
  );
}
