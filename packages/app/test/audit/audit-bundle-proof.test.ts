/** Exercises bundle provenance against real HTTP response bytes and adversarial registry/header mismatches. */
// @vitest-environment node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditBundle } from "../ui-smoke/audit-bundle-proof";

const body = 'export const CloudView = () => "Cloud";\n';
const digest = createHash("sha256").update(body).digest();
const declaration = {
  id: "cloud",
  componentExport: "CloudView",
  bundleUrl:
    "/api/views/cloud/installations/test-install/gui/bundle/bundle.js?v=version1",
};
const server = createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    "x-content-hash": `sha256-${digest.toString("base64")}`,
    etag: `"${digest.toString("hex")}"`,
  });
  res.end(body);
});
let origin: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP server address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
async function capture() {
  const response = await fetch(`${origin}${declaration.bundleUrl}`);
  return {
    mode: "runtime" as const,
    declaration,
    url: response.url,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

describe("audit bundle provenance", () => {
  it("records verified runtime bytes without requiring fixture-only headers", async () => {
    const input = await capture();
    const proof = verifyAuditBundle(input);
    expect(proof.bundleProvenance).toBe("real-runtime-sha256");
    expect(proof.bundleContentHash).toBe(`sha256-${digest.toString("base64")}`);
    expect(proof.bundleComponent).toBe("CloudView");
    expect(proof.bundleUrl).toBe(input.url);
  });
  it("rejects tampered bytes and wrong installation/version instead of relaxing provenance", async () => {
    const input = await capture();
    expect(() =>
      verifyAuditBundle({ ...input, bytes: Buffer.from("altered") }),
    ).toThrow(/hash verification/);
    expect(() =>
      verifyAuditBundle({
        ...input,
        url: input.url.replace("test-install", "other-install"),
      }),
    ).toThrow(/registered JavaScript/);
    expect(() =>
      verifyAuditBundle({
        ...input,
        url: input.url.replace("version1", "stale"),
      }),
    ).toThrow(/hash verification/);
    expect(() =>
      verifyAuditBundle({
        ...input,
        headers: { ...input.headers, "x-content-hash": "" },
      }),
    ).toThrow(/hash verification/);
  });
  it("keeps fixture production-bundle identity checks independent of runtime hashes", async () => {
    const input = await capture();
    expect(() => verifyAuditBundle({ ...input, mode: "fixture" })).toThrow(
      /fixture did not serve/,
    );
    const fixture = {
      ...input,
      mode: "fixture" as const,
      headers: {
        "content-type": "application/javascript",
        "x-eliza-view-bundle-provenance": "real-dist",
        "x-eliza-view-component": "CloudView",
        "x-eliza-view-id": "cloud",
      },
    };
    expect(verifyAuditBundle(fixture).bundleProvenance).toBe("real-dist");
    expect(() =>
      verifyAuditBundle({
        ...fixture,
        headers: {
          ...fixture.headers,
          "x-eliza-view-bundle-provenance": "synthesized",
        },
      }),
    ).toThrow(/fixture did not serve/);
  });
});
