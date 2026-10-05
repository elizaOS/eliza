/** Verifies captured plugin bundle bytes against the serving backend's own provenance contract. */
import { createHash } from "node:crypto";
import type { RemoteBundleDeclaration } from "./aesthetic-audit-rules";

export interface AuditBundleProof {
  bundleProvenance: "real-dist" | "real-runtime-sha256";
  bundleComponent: string;
  bundleViewId: string;
  bundleUrl: string;
  bundleContentHash: string;
}

export function verifyAuditBundle(input: {
  mode: "fixture" | "runtime";
  declaration: RemoteBundleDeclaration;
  url: string;
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}): AuditBundleProof {
  const { declaration, headers } = input;
  const expected = new URL(declaration.bundleUrl, "http://audit.local");
  const actual = new URL(input.url);
  if (
    input.status !== 200 ||
    actual.pathname !== expected.pathname ||
    !headers["content-type"]?.includes("javascript") ||
    input.bytes.length === 0
  ) {
    throw new Error(
      "Audit bundle response does not match the registered JavaScript asset",
    );
  }
  const digest = createHash("sha256").update(input.bytes).digest();
  const contentHash = `sha256-${digest.toString("base64")}`;
  if (input.mode === "fixture") {
    if (
      headers["x-eliza-view-bundle-provenance"] !== "real-dist" ||
      headers["x-eliza-view-component"] !== declaration.componentExport ||
      headers["x-eliza-view-id"] !== declaration.id
    ) {
      throw new Error(
        "Audit fixture did not serve the declared production bundle",
      );
    }
  } else {
    const installationPrefix = `/api/views/${encodeURIComponent(declaration.id)}/installations/`;
    if (
      !expected.pathname.startsWith(installationPrefix) ||
      !expected.searchParams.get("v") ||
      actual.searchParams.get("v") !== expected.searchParams.get("v") ||
      headers["x-content-hash"] !== contentHash ||
      headers.etag !== `"${digest.toString("hex")}"`
    ) {
      throw new Error(
        "Audit runtime bundle failed installation or response-byte hash verification",
      );
    }
  }
  return {
    bundleProvenance:
      input.mode === "fixture" ? "real-dist" : "real-runtime-sha256",
    bundleComponent: declaration.componentExport,
    bundleViewId: declaration.id,
    bundleUrl: input.url,
    bundleContentHash: contentHash,
  };
}
