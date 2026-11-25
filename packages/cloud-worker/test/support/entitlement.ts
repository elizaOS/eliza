// spec/cloud/billing/entitlements.md, "Story: Read my plan without substituting another account or source"
import { createPrivateKey, sign } from "node:crypto";

export interface PublishedKey {
  readonly kid: string;
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
}

export interface Verified {
  readonly header: Readonly<Record<string, unknown>>;
  readonly claims: Readonly<Record<string, unknown>>;
}

const decode = (part: string): Readonly<Record<string, unknown>> =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Readonly<Record<string, unknown>>;

export async function verifyEntitlement(
  token: string,
  keys: ReadonlyArray<PublishedKey>,
  expected: { readonly issuer: string; readonly audience: string; readonly nowSeconds: number },
): Promise<Verified> {
  const [head = "", body = "", signature = ""] = token.split(".");
  const header = decode(head);
  const claims = decode(body);
  const listed = keys.find((key) => key.kid === header.kid);
  if (header.alg !== "ES256" || header.typ !== "eliza-entitlement+jwt" || listed === undefined) throw new Error("not signed by a listed key");
  const key = await crypto.subtle.importKey("jwk", { kty: listed.kty, crv: listed.crv, x: listed.x, y: listed.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${head}.${body}`));
  const iat = Number(claims.iat);
  const exp = Number(claims.exp);
  if (!valid) throw new Error("signature does not verify");
  if (claims.iss !== expected.issuer || claims.aud !== expected.audience) throw new Error("issuer or audience differs");
  if (!(exp > iat && exp - iat <= 3600 && iat <= expected.nowSeconds + 60)) throw new Error("times out of bounds");
  return { header, claims };
}

export function resignedEntitlement(token: string, changed: Readonly<Record<string, unknown>>, pkcs8: string): string {
  const [head = "", body = ""] = token.split(".");
  const payload = Buffer.from(JSON.stringify({ ...decode(body), ...changed }), "utf8").toString("base64url");
  const key = createPrivateKey({ key: Buffer.from(pkcs8, "base64"), format: "der", type: "pkcs8" });
  return `${head}.${payload}.${sign("sha256", Buffer.from(`${head}.${payload}`, "utf8"), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
