import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
// @ts-expect-error - plain node script without type declarations.
import * as routeCodegen from "./_generate-router.mjs";

const {
  assertApprovedCodegenSkips,
  assertNoUnmountedRouteFiles,
  collectRouteEntries,
  isRouteCodegenSkippedSource,
} = routeCodegen;

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })),
  );
});

describe("route codegen skip directive", () => {
  test("matches only an exact byte-zero first line", () => {
    expect(
      isRouteCodegenSkippedSource("// route-codegen: skip\nexport {}"),
    ).toBeTrue();
    expect(
      isRouteCodegenSkippedSource("// route-codegen: skip\r\nexport {}"),
    ).toBeTrue();
    expect(isRouteCodegenSkippedSource("// route-codegen: skip")).toBeTrue();

    expect(isRouteCodegenSkippedSource("\n// route-codegen: skip")).toBeFalse();
    expect(
      isRouteCodegenSkippedSource(" // route-codegen: skip\n"),
    ).toBeFalse();
    expect(isRouteCodegenSkippedSource("﻿// route-codegen: skip\n")).toBeFalse();
    expect(
      isRouteCodegenSkippedSource("// route-codegen: skip later\n"),
    ).toBeFalse();
    expect(
      isRouteCodegenSkippedSource("export {};\n// route-codegen: skip\n"),
    ).toBeFalse();
  });

  test("keeps intentional skips separate from unconverted routes", async () => {
    const apiRoot = await mkdtemp(join(tmpdir(), "cloud-route-codegen-"));
    fixtures.push(apiRoot);

    const active = join(apiRoot, "v1", "active", "route.ts");
    const skipped = join(apiRoot, "v1", "skipped", "route.ts");
    const unconverted = join(apiRoot, "v1", "next", "route.ts");
    await Promise.all(
      [active, skipped, unconverted].map((file) =>
        mkdir(join(file, ".."), { recursive: true }),
      ),
    );
    await Promise.all([
      writeFile(
        active,
        'import { Hono } from "hono";\nexport default new Hono();\n',
      ),
      writeFile(
        skipped,
        '// route-codegen: skip\nimport { Hono } from "hono";\nexport default new Hono();\n',
      ),
      writeFile(unconverted, "export async function GET() {}\n"),
    ]);

    const result = await collectRouteEntries(apiRoot);

    expect(result.entries.map((entry: { path: string }) => entry.path)).toEqual(
      ["/api/v1/active"],
    );
    expect(result.intentionallySkippedFiles).toEqual([skipped]);
    expect(result.unmountedFiles).toEqual([unconverted]);
    expect(result.unconverted).toBe(1);
    expect(() =>
      assertNoUnmountedRouteFiles(result.unmountedFiles, apiRoot),
    ).toThrow("v1/next/route.ts");
    expect(() => assertNoUnmountedRouteFiles([], apiRoot)).not.toThrow();
  });

  test("enforces the exact reviewed skip allowlist in the real route tree", async () => {
    const apiRoot = resolve(import.meta.dir, "..");
    const result = await collectRouteEntries(apiRoot);
    const actual = result.intentionallySkippedFiles
      .map((file: string) => relative(apiRoot, file).replace(/\\/g, "/"))
      .sort();

    expect(actual).toEqual([
      "v1/cron/remote-host-managed-cleanup/route.ts",
      "v1/remote/hosts/[id]/managed-network/activate/route.ts",
      "v1/remote/sessions/activate/route.ts",
    ]);
    expect(() =>
      assertApprovedCodegenSkips(result.intentionallySkippedFiles, apiRoot),
    ).not.toThrow();
    expect(() =>
      assertApprovedCodegenSkips(
        [
          ...result.intentionallySkippedFiles,
          join(apiRoot, "v1", "unexpected", "route.ts"),
        ],
        apiRoot,
      ),
    ).toThrow("exact route skip allowlist mismatch");
  });
});
