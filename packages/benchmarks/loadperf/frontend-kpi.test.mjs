/** Verifies the local KPI server's deploy-like transfer and HTTP error contracts. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { serveDist } from "./frontend-kpi.mjs";

const cleanups = [];
const SCRIPT = "export const eliza = 'agent';\n".repeat(100);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixtureServer(options) {
  const root = await mkdtemp(join(tmpdir(), "eliza-loadperf-"));
  await writeFile(join(root, "index.html"), "<main>Eliza</main>");
  await writeFile(join(root, "app.js"), SCRIPT);
  await writeFile(
    join(root, "image.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  const server = await serveDist(root, options);
  cleanups.push(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return server;
}

describe("frontend KPI static server", () => {
  it("serves compressible assets with the deployed Brotli response contract", async () => {
    const { url } = await fixtureServer();
    const response = await fetch(new URL("app.js", url), {
      headers: { "accept-encoding": "br" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("vary")).toBe("accept-encoding");
    const expectedLength = brotliCompressSync(Buffer.from(SCRIPT), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    }).length;
    expect(Number(response.headers.get("content-length"))).toBe(expectedLength);
    expect(await response.text()).toContain("export const eliza");
  });

  it("keeps identity clients and binary assets uncompressed", async () => {
    const { url } = await fixtureServer();
    const identity = await fetch(new URL("app.js", url), {
      headers: { "accept-encoding": "identity" },
    });
    const binary = await fetch(new URL("image.png", url), {
      headers: { "accept-encoding": "br" },
    });

    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(identity.headers.get("vary")).toBe("accept-encoding");
    expect(Number(identity.headers.get("content-length"))).toBe(
      Buffer.byteLength(SCRIPT),
    );
    expect(binary.headers.get("content-encoding")).toBeNull();
    expect(binary.headers.get("vary")).toBe("accept-encoding");
    expect(Number(binary.headers.get("content-length"))).toBe(4);
  });

  it("serves the app shell for client-side routes", async () => {
    const { url } = await fixtureServer();
    const response = await fetch(new URL("settings/agents", url), {
      headers: { "accept-encoding": "identity" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<main>Eliza</main>");
  });

  it("distinguishes missing, malformed, and unexpected filesystem failures", async () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    const missingServer = await fixtureServer({
      readFile: () => {
        throw missing;
      },
    });
    const malformedResponse = await fetch(`${missingServer.url}%`);
    const missingResponse = await fetch(missingServer.url);

    expect(malformedResponse.status).toBe(400);
    expect(missingResponse.status).toBe(404);

    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const deniedServer = await fixtureServer({
      readFile: () => {
        throw denied;
      },
    });
    const deniedResponse = await fetch(deniedServer.url);
    expect(deniedResponse.status).toBe(500);
    expect(await deniedResponse.text()).toBe("static asset read failed");
  });
});
