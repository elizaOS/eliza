/**
 * Exercises deterministic bundle inventory and bounded byte verification with
 * local files and an in-memory HTTP boundary; production networking is covered
 * by the deployment workflow after Cloudflare reports the exact release SHA.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDistManifest,
  MANIFEST_FILENAME,
  verifyPublishedBundle,
} from "./dist-manifest.mjs";

const temporaryDirectories = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eliza-army-dist-manifest-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><title>eliza.army</title>\n",
  );
  await writeFile(
    join(root, "skill-manifest.json"),
    '{"name":"contribute-to-eliza"}\n',
  );
  await writeFile(
    join(root, "assets", "index-test.js"),
    "export const ready = true;\n",
  );
  await writeFile(
    join(root, "_headers"),
    "/*\n  X-Content-Type-Options: nosniff\n",
  );
  await writeFile(join(root, "_redirects"), "/* /index.html 200\n");
  return root;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Cloudflare Pages deployment manifest", () => {
  it("creates a deterministic inventory while excluding Pages control files", async () => {
    const root = await fixture();
    const manifest = await createDistManifest(root);
    const manifestBytes = await readFile(join(root, MANIFEST_FILENAME));

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.map((record) => record.path)).toEqual([
      "assets/index-test.js",
      "index.html",
      "skill-manifest.json",
    ]);
    expect(manifest.files.map((record) => record.path)).not.toContain(
      "_headers",
    );
    expect(manifest.files.map((record) => record.path)).not.toContain(
      "_redirects",
    );
    expect(manifest.files.map((record) => record.path)).not.toContain(
      MANIFEST_FILENAME,
    );
    expect(manifestBytes.toString("utf8")).toBe(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    expect(manifest.files[0].sha256).toBe(
      sha256(await readFile(join(root, manifest.files[0].path))),
    );
  });

  it("rejects symbolic links instead of publishing files outside the bundle", async () => {
    const root = await fixture();
    await symlink(join(root, "index.html"), join(root, "linked.html"));

    await expect(createDistManifest(root)).rejects.toThrow(/symbolic links/u);
  });

  it("verifies the manifest and every inventoried file with cache-busting requests", async () => {
    const root = await fixture();
    const manifest = await createDistManifest(root);
    const requested = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      const path = decodeURIComponent(parsed.pathname.slice(1));
      requested.push({ init, path, token: parsed.searchParams.get("verify") });
      return new Response(await readFile(join(root, path)), { status: 200 });
    };

    await expect(
      verifyPublishedBundle(root, "https://eliza.army", "release-1", {
        concurrency: 2,
        fetchImpl,
        retries: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(manifest.files.length);
    expect(requested[0].path).toBe(MANIFEST_FILENAME);
    expect(requested.map((request) => request.path).sort()).toEqual(
      [
        MANIFEST_FILENAME,
        ...manifest.files.map((record) => record.path),
      ].sort(),
    );
    expect(requested.every((request) => request.token === "release-1-1")).toBe(
      true,
    );
    expect(
      requested.every(
        (request) =>
          request.init.redirect === "manual" &&
          request.init.cache === "no-store" &&
          request.init.headers["Cache-Control"] === "no-cache",
      ),
    ).toBe(true);
  });

  it("fails closed when any published asset differs from the verified bundle", async () => {
    const root = await fixture();
    await createDistManifest(root);
    const fetchImpl = async (url) => {
      const path = decodeURIComponent(new URL(url).pathname.slice(1));
      const contents =
        path === "assets/index-test.js"
          ? Buffer.from("tampered")
          : await readFile(join(root, path));
      return new Response(contents, { status: 200 });
    };

    await expect(
      verifyPublishedBundle(root, "https://eliza.army", "release-2", {
        concurrency: 2,
        fetchImpl,
        retries: 1,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/published assets\/index-test\.js did not match/u);
  });

  it("rejects stale manifests when the local bundle changes", async () => {
    const root = await fixture();
    await createDistManifest(root);
    await writeFile(join(root, "index.html"), "changed after verification\n");

    await expect(
      verifyPublishedBundle(root, "https://eliza.army", "release-3", {
        fetchImpl: async () => new Response("unused", { status: 200 }),
        retries: 1,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/does not match the local Pages bundle/u);
  });

  it("rejects verification settings that exceed the production time bound", async () => {
    const root = await fixture();
    await createDistManifest(root);

    await expect(
      verifyPublishedBundle(root, "https://eliza.army", "release-4", {
        totalTimeoutMs: 300_001,
      }),
    ).rejects.toThrow(/options exceed their bounds/u);
  });
});
