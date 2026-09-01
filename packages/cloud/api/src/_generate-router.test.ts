import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error - plain node script without type declarations.
import * as routeCodegen from "./_generate-router.mjs";

const { assertNoUnmountedRouteFiles, collectRouteEntries } = routeCodegen;

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })),
  );
});

describe("route codegen mount contract", () => {
  test("fails closed on an unconverted route without hiding Hono leaves", async () => {
    const apiRoot = await mkdtemp(join(tmpdir(), "cloud-route-codegen-"));
    fixtures.push(apiRoot);

    const active = join(apiRoot, "v1", "active", "route.ts");
    const formerlySkipped = join(apiRoot, "v1", "formerly-skipped", "route.ts");
    const unconverted = join(apiRoot, "v1", "next", "route.ts");
    await Promise.all(
      [active, formerlySkipped, unconverted].map((file) =>
        mkdir(join(file, ".."), { recursive: true }),
      ),
    );
    await Promise.all([
      writeFile(
        active,
        'import { Hono } from "hono";\nexport default new Hono();\n',
      ),
      writeFile(
        formerlySkipped,
        '// route-codegen: skip\nimport { Hono } from "hono";\nexport default new Hono();\n',
      ),
      writeFile(unconverted, "export async function GET() {}\n"),
    ]);

    const result = await collectRouteEntries(apiRoot);

    expect(result.entries.map((entry: { path: string }) => entry.path)).toEqual(
      ["/api/v1/active", "/api/v1/formerly-skipped"],
    );
    expect(result.unmountedFiles).toEqual([unconverted]);
    expect(result.unconverted).toBe(1);
    expect(() =>
      assertNoUnmountedRouteFiles(result.unmountedFiles, apiRoot),
    ).toThrow("v1/next/route.ts");
    expect(() => assertNoUnmountedRouteFiles([], apiRoot)).not.toThrow();
  });

  test("mounts every real Hono leaf, including live remote routes", async () => {
    const apiRoot = resolve(import.meta.dir, "..");
    const result = await collectRouteEntries(apiRoot);
    const mountedPaths = result.entries.map(
      (entry: { path: string }) => entry.path,
    );

    expect(result.unmountedFiles).toEqual([]);
    expect(result.unconverted).toBe(0);
    expect(mountedPaths).toContain("/api/v1/cron/remote-host-managed-cleanup");
    expect(mountedPaths).toContain(
      "/api/v1/remote/hosts/:id/managed-network/activate",
    );
    expect(mountedPaths).toContain("/api/v1/remote/sessions/activate");
    expect(() =>
      assertNoUnmountedRouteFiles(result.unmountedFiles, apiRoot),
    ).not.toThrow();
  });
});
