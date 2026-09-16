/** Exercises generator output reconciliation on real temporary directories, including stale and foreign files. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectPublicRouteOutputs,
  PUBLIC_ROUTE_GENERATED_HEADER,
  PUBLIC_ROUTE_OUTPUT_PATHS,
  reconcilePublicRouteOutputs,
} from "../scripts/public-route-outputs.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "public-route-outputs-"));
  roots.push(root);
  const outputs = PUBLIC_ROUTE_OUTPUT_PATHS.map((relativePath) => ({
    relativePath,
    source: `${PUBLIC_ROUTE_GENERATED_HEADER}\nexport const route = ${JSON.stringify(relativePath)};\n`,
  }));
  return { root, outputs };
}

describe("public route generator output reconciliation", () => {
  test("reports missing and stale output without writing, then regenerates deterministically", async () => {
    const { root, outputs } = await fixture();
    expect(
      await reconcilePublicRouteOutputs(root, outputs, { check: true }),
    ).toContain("public-routes.ts");
    expect((await inspectPublicRouteOutputs(root)).missing).toContain(
      "public-routes.ts",
    );
    await reconcilePublicRouteOutputs(root, outputs);
    const snapshots = await Promise.all(
      outputs.map(({ relativePath }) =>
        readFile(path.join(root, relativePath), "utf8"),
      ),
    );
    await reconcilePublicRouteOutputs(root, outputs);
    expect(
      await Promise.all(
        outputs.map(({ relativePath }) =>
          readFile(path.join(root, relativePath), "utf8"),
        ),
      ),
    ).toEqual(snapshots);
    expect(
      await reconcilePublicRouteOutputs(root, outputs, { check: true }),
    ).toEqual([]);
    await writeFile(path.join(root, "public-routes.ts"), "stale facade");
    expect(
      await reconcilePublicRouteOutputs(root, outputs, { check: true }),
    ).toEqual(["public-routes.ts"]);
    expect(await readFile(path.join(root, "public-routes.ts"), "utf8")).toBe(
      "stale facade",
    );
  });

  test("removes only generator-owned orphan modules and keeps handwritten transport", async () => {
    const { root, outputs } = await fixture();
    await reconcilePublicRouteOutputs(root, outputs);
    const orphan = "public-routes/retired.generated.ts";
    await writeFile(
      path.join(root, orphan),
      `${PUBLIC_ROUTE_GENERATED_HEADER}\n`,
    );
    const transport = path.join(root, "public-routes/transport.ts");
    await writeFile(transport, "handwritten transport");
    expect(
      await reconcilePublicRouteOutputs(root, outputs, { check: true }),
    ).toEqual([orphan]);
    await reconcilePublicRouteOutputs(root, outputs);
    await expect(readFile(path.join(root, orphan))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    expect(await readFile(transport, "utf8")).toBe("handwritten transport");
  });

  test("rejects duplicate outputs before replacing existing files", async () => {
    const { root, outputs } = await fixture();
    await reconcilePublicRouteOutputs(root, outputs);
    await expect(
      reconcilePublicRouteOutputs(root, [
        outputs[0],
        outputs[0],
        ...outputs.slice(2),
      ]),
    ).rejects.toThrow("owned inventory");
    expect(
      await reconcilePublicRouteOutputs(root, outputs, { check: true }),
    ).toEqual([]);
  });

  test("refuses foreign generated files and symlinks without touching their contents", async () => {
    const { root, outputs } = await fixture();
    await reconcilePublicRouteOutputs(root, outputs);
    const foreign = path.join(root, "public-routes/foreign.generated.ts");
    await writeFile(foreign, "owned by another generator");
    await expect(reconcilePublicRouteOutputs(root, outputs)).rejects.toThrow(
      "foreign",
    );
    expect(await readFile(foreign, "utf8")).toBe("owned by another generator");
    await rm(foreign);
    const target = path.join(root, "external.ts");
    await writeFile(target, "external content");
    await symlink(target, foreign);
    await expect(reconcilePublicRouteOutputs(root, outputs)).rejects.toThrow(
      "foreign",
    );
    expect(await readFile(target, "utf8")).toBe("external content");
  });
});
