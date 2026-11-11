#!/usr/bin/env bun
/**
 * pack-check: prove that a product can build the Cloud API Worker from npm
 * packages alone, with no upstream checkout.
 *
 *   bun packages/cloud/deploy/scripts/pack-check.ts --work <dir outside the repo>
 *       [--built <tree with built dist>] [--public workspace|registry]
 *       [--environment staging|production] [--deployment <file>]
 *
 * It packs the source-shipped Cloud packages (and, with `--public workspace`,
 * the published workspace packages the Worker bundle draws from) into
 * tarballs, installs them into an empty product directory, renders the
 * example product's API configuration with the installed
 * `@elizaos/cloud-deploy`, and bundles the product's own thin `worker.ts`
 * with `wrangler deploy --dry-run`.
 *
 * It fails when a tarball carries a test, fixture or secret file, an `exports`
 * target is missing from a tarball, a packed manifest still has a
 * `workspace:` range, a rendered path or a bundle input resolves outside the
 * product directory, or (with `--public workspace`) the bundle takes code of
 * an `@elizaos` package this run did not pack.
 *
 * Nothing is published, uploaded or deployed. Packages are staged as copies:
 * neither the checkout nor the built tree is written to. Third-party
 * dependencies are installed from the public npm registry.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type Json = Record<string, unknown>;

const UPSTREAM_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

/** Packages shipped as TypeScript sources; none is published today. */
const SOURCE_PACKAGES = [
  "@elizaos/cloud-api",
  "@elizaos/cloud-shared",
  "@elizaos/cloud-services-common",
  "@elizaos/plugin-network",
  "@elizaos/cloud-deploy",
] as const;

/**
 * Published workspace packages whose code enters the API Worker bundle. With
 * `--public workspace` each is packed from the built tree, so the bundle is
 * of this revision and not of whatever the registry holds. The run fails if
 * the bundle takes code of an `@elizaos` package missing from this list.
 */
const BUNDLED_PUBLIC_PACKAGES = [
  "@elizaos/auth",
  "@elizaos/cloud-sdk",
  "@elizaos/contracts",
  "@elizaos/core",
  "@elizaos/host",
  "@elizaos/plugin-assistant",
  "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-google-workspace",
  "@elizaos/plugin-mcp",
  "@elizaos/plugin-native-inference",
  "@elizaos/plugin-scheduling",
  "@elizaos/plugin-sql",
  "@elizaos/plugin-sqlite",
  "@elizaos/plugin-todos",
  "@elizaos/plugin-wallet",
  "@elizaos/plugin-web-search",
  "@elizaos/voice",
] as const;

/** Not a workspace member, so the root manifest does not list it. */
const EXTRA_PACKAGE_DIRS = ["packages/cloud/deploy"];

const NEVER_COPIED = new Set([
  "node_modules",
  ".turbo",
  ".wrangler",
  ".wrangler-dry-run",
  ".git",
]);

/** A path no source tarball may contain. */
const FORBIDDEN_FILE =
  /(^|\/)\.env($|\.)|(^|\/)\.dev\.vars|(^|\/)\.npmrc$|\.(pem|key|p8|p12)$|\.test\.[cm]?[jt]sx?$|(^|\/)(__tests__|__fixtures__|__mocks__|fixtures|test-support)\//;

const PRODUCT_WORKER = `// The product's whole Worker: upstream's fetch and scheduled handlers and its
// Durable Object classes, from the installed package.
export * from "@elizaos/cloud-api/worker";
export { default } from "@elizaos/cloud-api/worker";
`;

class CheckFailure extends Error {}

function fail(message: string): never {
  throw new CheckFailure(message);
}

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

function isInside(dir: string, path: string): boolean {
  const moved = relative(dir, path);
  return (
    moved === "" ||
    (!moved.startsWith(`..${sep}`) && moved !== ".." && !isAbsolute(moved))
  );
}

interface Workspace {
  readonly name: string;
  readonly version: string;
  /** Directory relative to the repository root. */
  readonly dir: string;
  readonly manifest: Json;
}

/** Every workspace package of the checkout, by name. */
function readWorkspaces(root: string): Map<string, Workspace> {
  const patterns = [
    ...((readJson(join(root, "package.json")).workspaces as string[]) ?? []),
    ...EXTRA_PACKAGE_DIRS,
  ];
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      dirs.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    if (!existsSync(join(root, parent))) continue;
    for (const entry of readdirSync(join(root, parent), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
    }
  }
  const found = new Map<string, Workspace>();
  for (const dir of dirs) {
    const file = join(root, dir, "package.json");
    if (!existsSync(file)) continue;
    const manifest = readJson(file);
    if (typeof manifest.name !== "string") continue;
    found.set(manifest.name, {
      name: manifest.name,
      version: String(manifest.version),
      dir,
      manifest,
    });
  }
  return found;
}

/** `workspace:` ranges replaced by the version the workspace has now. */
function resolveWorkspaceRanges(
  manifest: Json,
  workspaces: Map<string, Workspace>,
): Json {
  const out: Json = { ...manifest };
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const deps = manifest[field] as Record<string, string> | undefined;
    if (!deps) continue;
    const resolved: Record<string, string> = {};
    for (const [name, range] of Object.entries(deps)) {
      if (!range.startsWith("workspace:")) {
        resolved[name] = range;
        continue;
      }
      const target = workspaces.get(name);
      if (!target)
        fail(
          `${manifest.name}: ${name} is ${range} but no workspace has that name`,
        );
      const spec = range.slice("workspace:".length);
      resolved[name] =
        spec === "^" || spec === "~"
          ? `${spec}${target.version}`
          : spec === "*" || spec === ""
            ? target.version
            : spec;
    }
    out[field] = resolved;
  }
  return out;
}

function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (NEVER_COPIED.has(entry.name)) return [];
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(join(dir, entry.name), name)
      : [name];
  });
}

/** Files of `src` that differ between two trees of the same package. */
function sourceDrift(a: string, b: string): string[] {
  const left = listFiles(join(a, "src"));
  const right = new Set(listFiles(join(b, "src")));
  const drift = left.filter((file) => !right.has(file));
  const leftSet = new Set(left);
  for (const file of right) if (!leftSet.has(file)) drift.push(file);
  for (const file of left) {
    if (!right.has(file)) continue;
    if (
      !readFileSync(join(a, "src", file)).equals(
        readFileSync(join(b, "src", file)),
      )
    ) {
      drift.push(file);
    }
  }
  return drift;
}

interface Packed {
  readonly name: string;
  readonly version: string;
  readonly kind: "source" | "public";
  readonly tarball: string;
  readonly bytes: number;
  readonly unpackedBytes: number;
  readonly fileCount: number;
}

/** String leaves of an `exports` value: the files it can resolve to. */
function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value as Json).flatMap(exportTargets);
  return [];
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
  };
}

function packOne(input: {
  readonly workspace: Workspace;
  readonly kind: "source" | "public";
  readonly sourceRoot: string;
  readonly workspaces: Map<string, Workspace>;
  readonly stageRoot: string;
  readonly tarballDir: string;
}): Packed {
  const { workspace, kind, sourceRoot, workspaces, stageRoot, tarballDir } =
    input;
  const from = join(sourceRoot, workspace.dir);
  const stage = join(stageRoot, workspace.name.replace("/", "__"));
  cpSync(from, stage, {
    recursive: true,
    filter: (source) =>
      !NEVER_COPIED.has(source.slice(source.lastIndexOf(sep) + 1)),
  });
  // The manifest is the checkout's, whichever tree the files came from.
  const manifest = resolveWorkspaceRanges(workspace.manifest, workspaces);
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const packed = run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", tarballDir],
    stage,
  );
  if (packed.status !== 0)
    fail(`npm pack failed for ${workspace.name}:\n${packed.stderr}`);
  const report = (JSON.parse(packed.stdout) as Json[])[0];
  const files = (report.files as { path: string }[]).map((file) => file.path);
  const present = new Set(files);

  const problems: string[] = [];
  if (
    JSON.stringify(readJson(join(stage, "package.json"))).includes("workspace:")
  )
    problems.push("the packed manifest still has a workspace: range");
  if (kind === "source") {
    for (const file of files) {
      if (FORBIDDEN_FILE.test(file))
        problems.push(`ships a test, fixture or secret file: ${file}`);
    }
    const targets = [
      ...exportTargets(manifest.exports),
      ...(typeof manifest.main === "string" ? [manifest.main] : []),
      ...Object.values((manifest.bin as Record<string, string>) ?? {}),
    ];
    for (const target of targets) {
      if (target.includes("*")) continue;
      if (!present.has(target.replace(/^\.\//, "")))
        problems.push(
          `an exports, main or bin target is not in the tarball: ${target}`,
        );
    }
  } else {
    const entry = String(manifest.main ?? "").replace(/^\.\//, "");
    if (entry && !present.has(entry))
      problems.push(
        `main (${entry}) is not in the tarball; the package is not built in ${sourceRoot}`,
      );
  }
  if (problems.length > 0)
    fail(`${workspace.name} is not packable:\n  ${problems.join("\n  ")}`);

  return {
    name: workspace.name,
    version: workspace.version,
    kind,
    tarball: join(tarballDir, String(report.filename)),
    bytes: Number(report.size),
    unpackedBytes: Number(report.unpackedSize),
    fileCount: files.length,
  };
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const known = ["work", "built", "public", "environment", "deployment"];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index].startsWith("--") ? argv[index].slice(2) : "";
    const value = argv[index + 1];
    if (!known.includes(name) || value === undefined)
      fail(
        `usage: pack-check --work <dir> [--built <tree>] [--public workspace|registry] [--environment staging|production] [--deployment <file>]`,
      );
    flags[name] = value;
  }
  return flags;
}

function main(argv: readonly string[]): number {
  const flags = parseArgs(argv);
  if (!flags.work) fail("--work <dir outside the repository> is required");
  const upstream = realpathSync(UPSTREAM_ROOT);
  const built = realpathSync(resolve(flags.built ?? UPSTREAM_ROOT));
  const publicFrom = flags.public ?? "workspace";
  if (publicFrom !== "workspace" && publicFrom !== "registry")
    fail("--public must be workspace or registry");
  const environment = flags.environment ?? "staging";
  const deploymentFile = resolve(
    flags.deployment ??
      join(UPSTREAM_ROOT, "packages/cloud/deploy/examples/product.json"),
  );

  mkdirSync(resolve(flags.work), { recursive: true });
  const work = realpathSync(resolve(flags.work));
  const forbiddenRoots = [...new Set([upstream, built])];
  for (const root of forbiddenRoots) {
    if (isInside(root, work) || isInside(work, root))
      fail(`--work (${work}) must be outside ${root}`);
  }
  const stageRoot = join(work, "stage");
  const tarballDir = join(work, "tarballs");
  const product = join(work, "product");
  const bundleDir = join(work, "bundle");
  const metafile = join(work, "bundle-meta.json");
  for (const dir of [stageRoot, tarballDir, product, bundleDir]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  rmSync(metafile, { force: true });

  // 1. Pack.
  const workspaces = readWorkspaces(upstream);
  const packed: Packed[] = [];
  const pack = (name: string, kind: "source" | "public") => {
    const workspace = workspaces.get(name);
    if (!workspace) fail(`no workspace package named ${name}`);
    const sourceRoot = kind === "public" ? built : upstream;
    if (kind === "public" && built !== upstream) {
      const drift = sourceDrift(
        join(upstream, workspace.dir),
        join(built, workspace.dir),
      );
      if (drift.length > 0) {
        fail(
          `${name}: the built tree's sources differ from this checkout (${drift.length} files, e.g. ${drift.slice(0, 3).join(", ")}); its dist is not a build of this revision`,
        );
      }
    }
    console.error(`packing ${name} (${kind})`);
    packed.push(
      packOne({
        workspace,
        kind,
        sourceRoot,
        workspaces,
        stageRoot,
        tarballDir,
      }),
    );
  };
  for (const name of SOURCE_PACKAGES) pack(name, "source");
  if (publicFrom === "workspace")
    for (const name of BUNDLED_PUBLIC_PACKAGES) pack(name, "public");
  rmSync(stageRoot, { recursive: true, force: true });

  // 2. An empty product that depends on the tarballs and nothing else.
  const tarballOf = (name: string): string => {
    const entry = packed.find((candidate) => candidate.name === name);
    if (!entry) fail(`${name} was not packed`);
    return `file:${relative(product, entry.tarball).split(sep).join("/")}`;
  };
  const direct = ["@elizaos/cloud-api", "@elizaos/cloud-deploy"];
  writeFileSync(
    join(product, "package.json"),
    `${JSON.stringify(
      {
        name: "cloud-pack-check-product",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          direct.map((name) => [name, tarballOf(name)]),
        ),
        // Stands in for the registry: every packed package resolves to its
        // tarball wherever the dependency graph asks for it.
        overrides: Object.fromEntries(
          packed
            .filter((entry) => !direct.includes(entry.name))
            .map((entry) => [entry.name, tarballOf(entry.name)]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(product, "worker.ts"), PRODUCT_WORKER);
  writeFileSync(join(product, "deployment.json"), readFileSync(deploymentFile));

  console.error("installing into the product directory");
  const installStarted = Date.now();
  const install = run("bun", ["install", "--ignore-scripts"], product);
  if (install.status !== 0)
    fail(
      `bun install failed in ${product}:\n${install.stdout}\n${install.stderr}`,
    );
  const installSeconds = Math.round((Date.now() - installStarted) / 1000);
  const installedElizaos = readdirSync(
    join(product, "node_modules", "@elizaos"),
  );
  for (const entry of packed) {
    const dir = join(product, "node_modules", ...entry.name.split("/"));
    if (!existsSync(dir)) fail(`${entry.name} was not installed`);
    if (!isInside(product, realpathSync(dir)))
      fail(
        `${entry.name} is installed as a link out of the product: ${realpathSync(dir)}`,
      );
  }

  // 3. Render with the installed cloud-deploy, from the installed packages.
  const cli = join(product, "node_modules/@elizaos/cloud-deploy/src/cli.ts");
  const render = run(
    "bun",
    [
      cli,
      "render",
      "--deployment",
      "deployment.json",
      "--environment",
      environment,
      "--packages",
      product,
      "--main",
      "worker.ts",
      "--out",
      product,
    ],
    product,
  );
  if (render.status !== 0)
    fail(`render failed:\n${render.stdout}\n${render.stderr}`);
  const configFile = join(product, `wrangler.${environment}.jsonc`);
  const configText = readFileSync(configFile, "utf8");
  const config = JSON.parse(
    configText
      .split("\n")
      .filter((line) => !line.startsWith("//"))
      .join("\n"),
  ) as Json;

  const escaped: string[] = [];
  const mustStayInProduct = (what: string, path: string) => {
    if (!existsSync(path)) {
      escaped.push(`${what} does not exist: ${path}`);
      return;
    }
    const real = realpathSync(path);
    if (
      !isInside(product, real) ||
      forbiddenRoots.some((root) => isInside(root, real))
    )
      escaped.push(`${what} resolves outside the product: ${real}`);
  };
  mustStayInProduct("main", resolve(product, String(config.main)));
  const aliases = (config.alias ?? {}) as Record<string, string>;
  for (const [name, target] of Object.entries(aliases)) {
    if (target.startsWith("./") || target.startsWith("../"))
      mustStayInProduct(`alias ${name}`, resolve(product, target));
  }
  for (const root of forbiddenRoots) {
    if (configText.includes(root))
      escaped.push(`the rendered configuration names ${root}`);
  }
  if (escaped.length > 0) fail(escaped.join("\n"));

  // 4. Bundle the product's worker.ts.
  console.error("bundling with wrangler deploy --dry-run");
  const check = run(
    "bun",
    [
      cli,
      "check",
      "--config",
      configFile,
      "--keep",
      bundleDir,
      "--metafile",
      metafile,
    ],
    product,
  );
  const jsonStart = check.stdout.lastIndexOf("\n{\n");
  const checked = JSON.parse(
    check.stdout.slice(jsonStart === -1 ? 0 : jsonStart),
  ) as Json;
  if (check.status !== 0 || checked.ok !== true)
    fail(`the dry-run bundle failed:\n${check.stderr.slice(-6000)}`);
  if (!isInside(product, realpathSync(String(checked.wrangler))))
    fail(`wrangler came from outside the product: ${checked.wrangler}`);

  // 5. Every file the bundler read is inside the product.
  const inputs = Object.keys(
    (readJson(metafile).inputs ?? {}) as Record<string, unknown>,
  );
  const outside: string[] = [];
  const contributors = new Map<string, number>();
  let fileInputs = 0;
  for (const input of inputs) {
    // Virtual modules (`node-built-in-modules:fs`, `wrangler-internal:…`)
    // have no file. A module the bundler disabled (a package's `browser`
    // field) is named by the file it stands in for, which is still checked.
    const disabled = "(disabled):";
    const path = resolve(
      product,
      input.startsWith(disabled) ? input.slice(disabled.length) : input,
    );
    if (/^[a-z][a-z0-9-]*:/i.test(input) && !existsSync(path)) continue;
    if (!existsSync(path)) {
      outside.push(`${input} (not a file under the product)`);
      continue;
    }
    fileInputs += 1;
    const real = realpathSync(path);
    if (
      !isInside(product, real) ||
      forbiddenRoots.some((root) => isInside(root, real))
    ) {
      // Wrangler's own templates and shims sit beside its executable.
      outside.push(real);
      continue;
    }
    const match = relative(product, real)
      .split(sep)
      .join("/")
      .match(/(?:^|\/)node_modules\/(@elizaos\/[^/]+)\/(?!.*node_modules\/)/);
    if (match)
      contributors.set(match[1], (contributors.get(match[1]) ?? 0) + 1);
  }
  if (outside.length > 0) {
    fail(
      `${outside.length} bundle inputs resolve outside the product directory:\n  ${outside.slice(0, 20).join("\n  ")}`,
    );
  }
  const packedNames = new Set(packed.map((entry) => entry.name));
  const fromRegistry = [...contributors.keys()]
    .filter((name) => !packedNames.has(name))
    .sort();
  if (publicFrom === "workspace" && fromRegistry.length > 0) {
    fail(
      `the bundle takes code of packages this run did not pack (installed from the registry): ${fromRegistry.join(", ")}; add them to BUNDLED_PUBLIC_PACKAGES`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        upstream,
        built,
        public: publicFrom,
        product,
        tarballs: packed.map((entry) => ({
          name: entry.name,
          version: entry.version,
          kind: entry.kind,
          file: relative(work, entry.tarball),
          bytes: entry.bytes,
          unpackedBytes: entry.unpackedBytes,
          files: entry.fileCount,
        })),
        install: {
          command: "bun install --ignore-scripts",
          seconds: installSeconds,
          elizaosPackages: installedElizaos.length,
        },
        render: {
          config: configFile,
          main: config.main,
          aliases,
          output: render.stdout.trim().split("\n"),
        },
        bundle: {
          entry: checked.entry,
          wrangler: checked.wrangler,
          bundleBytes: checked.bundleBytes,
          totalUpload: checked.totalUpload,
          files: checked.files,
          outDir: checked.outDir,
          metafile,
        },
        resolution: {
          fileInputs,
          outsideProduct: outside.length,
          elizaosContributors: Object.fromEntries(
            [...contributors.entries()].sort(([a], [b]) => a.localeCompare(b)),
          ),
          elizaosFromRegistry: fromRegistry,
        },
        notValidated: [
          ...((checked.notValidated as string[]) ?? []),
          "publication (nothing is published; the packed manifests keep private: true where the checkout has it)",
          "the login, speech and admission Workers and the Pages front end, which are not packages",
        ],
      },
      null,
      2,
    ),
  );
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  if (error instanceof CheckFailure) {
    console.error(`pack-check failed: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
