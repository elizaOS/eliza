import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  CLOUD_API_PACKAGE,
  installedApiDir,
  parseRenderedConfig,
  parseToml,
  RenderError,
  renderWranglerConfig,
  UPSTREAM_API_DIR,
} from "./render";
import { renderComponent } from "./render-components";
import { validateDeployment } from "./schema";

type Table = Record<string, unknown>;

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const UPSTREAM_ROOT = resolve(PACKAGE_DIR, "..", "..", "..");
const API_DIR = join(UPSTREAM_ROOT, UPSTREAM_API_DIR);

const example = () =>
  validateDeployment(
    JSON.parse(
      readFileSync(join(PACKAGE_DIR, "examples/product.json"), "utf8"),
    ),
  );

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * A product directory with the API package installed the way a tarball
 * install leaves it: `wrangler.toml` and the stubs, copied, under
 * `node_modules`.
 */
function installedProduct(): string {
  const product = mkdtempSync(join(tmpdir(), "cloud-deploy-product-"));
  scratch.push(product);
  const apiDir = installedApiDir(product);
  mkdirSync(join(apiDir, "src"), { recursive: true });
  cpSync(join(API_DIR, "wrangler.toml"), join(apiDir, "wrangler.toml"));
  cpSync(join(API_DIR, "src", "stubs"), join(apiDir, "src", "stubs"), {
    recursive: true,
  });
  writeFileSync(join(apiDir, "src", "index.ts"), "export default {};\n");
  writeFileSync(join(product, "worker.ts"), "export default {};\n");
  return product;
}

function isInside(dir: string, path: string): boolean {
  const moved = relative(dir, path);
  return moved !== ".." && !moved.startsWith(`..${sep}`);
}

const upstreamToml = parseToml(
  readFileSync(join(API_DIR, "wrangler.toml"), "utf8"),
);
const upstreamAlias = upstreamToml.alias as Record<string, string>;
/** Aliases whose target is one of the API package's own files. */
const ownAliases = Object.keys(upstreamAlias).filter((name) =>
  isInside(API_DIR, resolve(API_DIR, upstreamAlias[name])),
);

describe("render from installed packages", () => {
  test("every path stays inside the product's node_modules", () => {
    const product = installedProduct();
    const rendered = renderWranglerConfig({
      deployment: example(),
      environment: "staging",
      packagesRoot: product,
      outDir: product,
    });
    const config = rendered.config;
    expect(config.main).toBe("./node_modules/@elizaos/cloud-api/src/index.ts");
    const alias = config.alias as Record<string, string>;
    expect(Object.keys(alias)).toEqual(ownAliases);
    for (const [name, target] of Object.entries(alias)) {
      const file = resolve(product, target);
      expect(file).toBe(
        join(installedApiDir(product), upstreamAlias[name].slice(2)),
      );
      expect(existsSync(file)).toBe(true);
    }
    expect(rendered.text).not.toContain(UPSTREAM_ROOT);
    expect(rendered.text).not.toContain("../");
  });

  test("an alias into a sibling workspace is dropped and reported", () => {
    const product = installedProduct();
    const rendered = renderWranglerConfig({
      deployment: example(),
      environment: "staging",
      packagesRoot: product,
      outDir: product,
    });
    const dropped = Object.keys(upstreamAlias).filter(
      (name) => !ownAliases.includes(name),
    );
    expect(dropped).toContain("@elizaos/cloud-shared");
    expect(dropped).toContain("@elizaos/cloud-sdk");
    expect(rendered.droppedAliases).toEqual(dropped);
    // A render from the checkout keeps every alias.
    const fromCheckout = renderWranglerConfig({
      deployment: example(),
      environment: "staging",
      upstreamRoot: UPSTREAM_ROOT,
      outDir: product,
    });
    expect(fromCheckout.droppedAliases).toEqual([]);
    expect(Object.keys(fromCheckout.config.alias as Table)).toEqual(
      Object.keys(upstreamAlias),
    );
  });

  test("the product's own entry replaces the package's, and nothing else changes", () => {
    const product = installedProduct();
    const options = {
      deployment: example(),
      environment: "production" as const,
      packagesRoot: product,
      outDir: join(product, "cloud"),
    };
    const packaged = renderWranglerConfig(options).config;
    const own = renderWranglerConfig({
      ...options,
      main: join(product, "worker.ts"),
    }).config;
    expect(packaged.main).toBe(
      "../node_modules/@elizaos/cloud-api/src/index.ts",
    );
    expect(own.main).toBe("../worker.ts");
    expect({ ...own, main: packaged.main }).toEqual(packaged);
    // Rendered beside the entry, the path is still explicitly relative.
    expect(
      renderWranglerConfig({
        ...options,
        outDir: product,
        main: join(product, "worker.ts"),
      }).config.main,
    ).toBe("./worker.ts");
  });

  test("structure and identity equal a render from the checkout", () => {
    const product = installedProduct();
    const packaged = renderWranglerConfig({
      deployment: example(),
      environment: "production",
      packagesRoot: product,
      outDir: product,
    }).config;
    const fromCheckout = renderWranglerConfig({
      deployment: example(),
      environment: "production",
      upstreamRoot: UPSTREAM_ROOT,
      outDir: product,
    }).config;
    const { main: _a, alias: _b, ...rest } = packaged;
    const { main: _c, alias: _d, ...expected } = fromCheckout;
    expect(rest).toEqual(expected);
  });

  test("refuses a missing install, both or neither source, and a stray entry", () => {
    const product = installedProduct();
    const base = {
      deployment: example(),
      environment: "staging" as const,
      outDir: product,
    };
    const empty = mkdtempSync(join(tmpdir(), "cloud-deploy-empty-"));
    scratch.push(empty);
    expect(() =>
      renderWranglerConfig({ ...base, packagesRoot: empty }),
    ).toThrow(`${CLOUD_API_PACKAGE} is not installed under ${empty}`);
    expect(() => renderWranglerConfig(base)).toThrow(
      "exactly one of upstreamRoot and packagesRoot",
    );
    expect(() =>
      renderWranglerConfig({
        ...base,
        packagesRoot: product,
        upstreamRoot: UPSTREAM_ROOT,
      }),
    ).toThrow("exactly one of upstreamRoot and packagesRoot");
    expect(() =>
      renderWranglerConfig({
        ...base,
        upstreamRoot: UPSTREAM_ROOT,
        main: join(product, "worker.ts"),
      }),
    ).toThrow("needs packagesRoot");
    expect(() =>
      renderWranglerConfig({
        ...base,
        packagesRoot: product,
        main: "worker.ts",
      }),
    ).toThrow("main must be an absolute path");
    expect(() =>
      renderWranglerConfig({ ...base, packagesRoot: "node_modules/.." }),
    ).toThrow("packagesRoot must be an absolute path");
  });

  test("refuses an installed main that leaves the package", () => {
    const product = installedProduct();
    const file = join(installedApiDir(product), "wrangler.toml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        'main = "src/index.ts"',
        'main = "../../../../outside.ts"',
      ),
    );
    expect(() =>
      renderWranglerConfig({
        deployment: example(),
        environment: "staging",
        packagesRoot: product,
        outDir: product,
      }),
    ).toThrow(RenderError);
  });

  test("only the API Worker renders from packages", () => {
    const product = installedProduct();
    for (const component of ["login", "speech", "admission", "web"] as const) {
      expect(() =>
        renderComponent({
          deployment: example(),
          environment: "staging",
          packagesRoot: product,
          outDir: product,
          component,
        }),
      ).toThrow("only the API Worker renders from installed packages");
    }
    expect(
      renderComponent({
        deployment: example(),
        environment: "staging",
        packagesRoot: product,
        outDir: product,
        component: "api",
      }).fileName,
    ).toBe("wrangler.staging.jsonc");
  });
});

describe("cloud-deploy render --packages", () => {
  const cli = join(PACKAGE_DIR, "src", "cli.ts");
  const run = (args: string[]) =>
    spawnSync("bun", [cli, "render", ...args], { encoding: "utf8" });
  const common = [
    "--deployment",
    join(PACKAGE_DIR, "examples/product.json"),
    "--environment",
    "staging",
  ];

  test("writes a configuration whose entry is the product's worker", () => {
    const product = installedProduct();
    const result = run([
      ...common,
      "--packages",
      product,
      "--main",
      join(product, "worker.ts"),
      "--out",
      product,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "resolved from node_modules instead of an upstream alias: ",
    );
    const config = parseRenderedConfig(
      readFileSync(join(product, "wrangler.staging.jsonc"), "utf8"),
    );
    expect(config.main).toBe("./worker.ts");
  });

  test("usage errors", () => {
    const product = installedProduct();
    const out = ["--out", product];
    const both = run([
      ...common,
      ...out,
      "--packages",
      product,
      "--upstream",
      UPSTREAM_ROOT,
    ]);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("exactly one of --upstream and --packages");
    expect(run([...common, ...out]).status).toBe(2);
    const component = run([
      ...common,
      ...out,
      "--packages",
      product,
      "--component",
      "all",
    ]);
    expect(component.status).toBe(2);
    expect(component.stderr).toContain(
      "--packages renders the API Worker only",
    );
    const entry = run([
      ...common,
      ...out,
      "--upstream",
      UPSTREAM_ROOT,
      "--main",
      join(product, "worker.ts"),
    ]);
    expect(entry.status).toBe(2);
    expect(entry.stderr).toContain("--main needs --packages");
  });
});

describe("packaging of the source-shipped Cloud packages", () => {
  const manifests = [
    "packages/cloud/api",
    "packages/cloud/shared",
    "packages/cloud/services/_common",
    "plugins/plugin-network",
    "packages/cloud/deploy",
  ].map((dir) => ({
    dir: join(UPSTREAM_ROOT, dir),
    manifest: JSON.parse(
      readFileSync(join(UPSTREAM_ROOT, dir, "package.json"), "utf8"),
    ) as Table,
  }));

  const targets = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value as Table).flatMap(targets)
        : [];

  test("each lists its files and every exports target exists", () => {
    for (const { dir, manifest } of manifests) {
      expect(Array.isArray(manifest.files)).toBe(true);
      expect(manifest.publishConfig).toEqual({ access: "public" });
      const missing = targets(manifest.exports).filter(
        (target) => !target.includes("*") && !existsSync(join(dir, target)),
      );
      expect({ name: manifest.name, missing }).toEqual({
        name: manifest.name,
        missing: [],
      });
    }
  });

  test("publication stays a maintainer's decision", () => {
    for (const { manifest } of manifests) expect(manifest.private).toBe(true);
    const cohort = JSON.parse(
      readFileSync(
        join(UPSTREAM_ROOT, "packages/scripts/release-cohort.json"),
        "utf8",
      ),
    ) as { packages: string[] };
    for (const { manifest } of manifests) {
      expect(cohort.packages).not.toContain(manifest.name as string);
    }
  });

  test("the API package exposes the Worker module and its wrangler.toml", () => {
    const api = manifests[0].manifest;
    const exported = api.exports as Record<string, string>;
    expect(exported["./worker"]).toBe("./src/index.ts");
    expect(exported["./wrangler.toml"]).toBe("./wrangler.toml");
    expect(
      parseToml(readFileSync(join(API_DIR, "wrangler.toml"), "utf8")).main,
    ).toBe(exported["./worker"].slice(2));
  });

  test("no shipped API source needs the package's tsconfig paths or a sibling's files", () => {
    // A bundler ignores tsconfig paths under node_modules, and an install
    // has no sibling directories: a shipped file may import only relative
    // paths inside the package and package specifiers.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name !== "node_modules" &&
            entry.name !== "__tests__" &&
            !(dir === API_DIR && entry.name.startsWith(".wrangler"))
          )
            walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
          continue;
        const file = relative(API_DIR, path);
        if (/^test\/(e2e|fixtures|native-worker)\//.test(file)) continue;
        if (/^test\/[^/]+$/.test(file)) continue;
        for (const match of readFileSync(path, "utf8").matchAll(
          /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
        )) {
          const specifier = match[1];
          if (
            specifier.startsWith("@/") ||
            (specifier.startsWith(".") &&
              !isInside(API_DIR, resolve(path, "..", specifier)))
          ) {
            offenders.push(`${file}: ${specifier}`);
          }
        }
      }
    };
    walk(API_DIR);
    expect(offenders).toEqual([]);
  });
});
