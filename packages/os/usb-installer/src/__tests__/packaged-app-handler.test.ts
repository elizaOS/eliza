// Verifies the packaged same-origin renderer/API boundary without opening a window.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPackagedAppHandler } from "../packaged-app-handler";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "elizaos-packaged-app-"),
  );
  roots.push(root);
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "index.html"), "<h1>elizaOS</h1>");
  await fs.writeFile(path.join(root, "assets", "app.js"), "export {};");
  const requests: Request[] = [];
  const handler = createPackagedAppHandler(root, async (request) => {
    requests.push(request);
    return Response.json({ pathname: new URL(request.url).pathname });
  });
  return { handler, requests };
}

describe("packaged app handler", () => {
  it("serves only existing renderer files with explicit content types", async () => {
    const { handler } = await fixture();
    const index = await handler(new Request("http://127.0.0.1:3742/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain("elizaOS");

    const script = await handler(
      new Request("http://127.0.0.1:3742/assets/app.js"),
    );
    expect(script.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(await script.text()).toBe("export {};");
    expect(
      (await handler(new Request("http://127.0.0.1:3742/missing"))).status,
    ).toBe(404);
  });

  it("rewrites only the API prefix and preserves the request method/body", async () => {
    const { handler, requests } = await fixture();
    const response = await handler(
      new Request("http://127.0.0.1:3742/api/plan?source=app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    expect(await response.json()).toEqual({ pathname: "/plan" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    await expect(requests[0]?.json()).resolves.toEqual({ dryRun: true });
  });

  it("fails closed on traversal, malformed encoding, and writes to renderer paths", async () => {
    const { handler } = await fixture();
    expect(
      (await handler(new Request("http://127.0.0.1:3742/%2e%2e/secret")))
        .status,
    ).toBe(404);
    expect(
      (await handler(new Request("http://127.0.0.1:3742/%ZZ"))).status,
    ).toBe(404);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1:3742/index.html", { method: "POST" }),
        )
      ).status,
    ).toBe(405);
  });
});
