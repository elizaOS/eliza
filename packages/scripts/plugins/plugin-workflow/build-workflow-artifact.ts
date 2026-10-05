#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
/** Build the reviewed phone workflow worker's dependency surface. No APK is built. */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { resolveMobileWorkflowPackage } from "../../lib/script-metadata.ts";
import { buildWorkflowCompiler } from "./build-workflow-compiler.mjs";
export interface WorkflowArtifactOptions {
  sourceRoot: string;
  outputDir: string;
  sourceIdentity: string;
}
/** Produce immutable resources only. Native extraction, signing, and enabling remain host responsibilities. */
export async function buildWorkflowArtifact(options: WorkflowArtifactOptions) {
  const source = realpathSync(options.sourceRoot),
    output = resolve(options.outputDir);
  if (!/^[a-f0-9]{64}$/.test(options.sourceIdentity))
    throw Error(
      "Source identity must be a SHA256 of the admitted source descriptor",
    );
  if (existsSync(output)) throw Error("Workflow artifact output must be fresh");
  if (output === source || source.startsWith(`${output}/`))
    throw Error("Workflow artifact cannot replace its source");
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "eliza-workflow-worker-input-"));
  try {
    const require = createRequire(
      join(
        source,
        resolveMobileWorkflowPackage({ repoRoot: source }),
        "package.json",
      ),
    );
    const smthrs = createRequire(require.resolve("smthrs"));
    const engine = createRequire(
      require.resolve("@smthrs/engine/cancel-subtree"),
    );
    const reactFacade = (specifier: string) => {
      const entry = engine.resolve(specifier);
      const names = Object.keys(engine(specifier)).filter(
        (name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name),
      );
      return `export {${names.join(",")}} from ${JSON.stringify(entry)}; export {default} from ${JSON.stringify(entry)};`;
    };
    // Compiled phone workflows use named ESM exports. require.resolve selects
    // Zod's CommonJS condition, whose export-star facade loses those names.
    const zodPackage = require.resolve("zod/package.json");
    const zodMetadata = JSON.parse(readFileSync(zodPackage, "utf8"));
    const zodEntry = resolve(
      dirname(zodPackage),
      zodMetadata.exports["."].import,
    );
    const entries: Record<string, string> = {
      smthrs: `export {runWorkflow,approveNode,denyNode,signalRun,approvalDecisionSchema} from ${JSON.stringify(require.resolve("smthrs"))};`,
      create: `export * from ${JSON.stringify(require.resolve("smthrs/create"))};`,
      store: `export * from ${JSON.stringify(require.resolve("smthrs/openSmithersStore"))};`,
      "jsx-runtime": `export * from ${JSON.stringify(require.resolve("smthrs/jsx-runtime"))};`,
      "engine-output": `export {resolveSchema,__engineInternals} from ${JSON.stringify(require.resolve("@smthrs/engine/engine"))};`,
      "output-snapshot": `export {loadRunOutputRowsEffect} from ${JSON.stringify(engine.resolve("@smthrs/db/snapshot"))};`,
      "cancel-subtree": `export * from ${JSON.stringify(require.resolve("@smthrs/engine/cancel-subtree"))};`,
      effect: `export * from ${JSON.stringify(smthrs.resolve("effect"))};`,
      zod: `export * from ${JSON.stringify(zodEntry)};`,
      react: reactFacade("react"),
      "react-jsx-runtime": reactFacade("react/jsx-runtime"),
      "react-jsx-dev-runtime": reactFacade("react/jsx-dev-runtime"),
      components: `export * from ${JSON.stringify(engine.resolve("@smthrs/components"))};`,
      graph: `export * from ${JSON.stringify(engine.resolve("@smthrs/graph"))};`,
      scheduler: `export * from ${JSON.stringify(engine.resolve("@smthrs/scheduler"))};`,
      "drizzle-bun-sqlite": `export {drizzle} from ${JSON.stringify(engine.resolve("drizzle-orm/bun-sqlite"))};`,
    };
    for (const [name, body] of Object.entries(entries))
      writeFileSync(join(staging, `${name}.ts`), body);
    const result = await Bun.build({
      entrypoints: Object.keys(entries).map((name) =>
        join(staging, `${name}.ts`),
      ),
      outdir: join(output, "lib"),
      target: "bun",
      format: "esm",
      splitting: true,
      naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
      minify: false,
      metafile: true,
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw Error(
        "Worker dependency bundle failed; incomplete output is retained for diagnosis",
      );
    }
    function pkg(
      name: string,
      exports: Record<string, string>,
      hasDefault = false,
    ) {
      const directory = join(output, "node_modules", name);
      mkdirSync(directory, { recursive: true });
      const mapped = Object.fromEntries(
        Object.entries(exports).map(([key, file]) => [key, `./${file}`]),
      );
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify(
          {
            name,
            type: "module",
            exports: { ...mapped, "./package.json": "./package.json" },
          },
          null,
          2,
        ),
      );
      for (const file of new Set(Object.values(exports))) {
        const target = relative(
          directory,
          join(output, "lib", file),
        ).replaceAll("\\", "/");
        const specifier = JSON.stringify(
          target.startsWith(".") ? target : `./${target}`,
        );
        writeFileSync(
          join(directory, file),
          `export * from ${specifier};\n${hasDefault ? `export {default} from ${specifier};\n` : ""}`,
        );
      }
    }
    pkg("smthrs", {
      ".": "smthrs.js",
      "./create": "create.js",
      "./openSmithersStore": "store.js",
      "./jsx-runtime": "jsx-runtime.js",
      "./jsx-dev-runtime": "jsx-runtime.js",
    });
    pkg("@smthrs/engine", {
      "./cancel-subtree": "cancel-subtree.js",
      "./engine": "engine-output.js",
    });
    pkg("@smthrs/db", { "./snapshot": "output-snapshot.js" });
    pkg("effect", { ".": "effect.js" });
    pkg("zod", { ".": "zod.js" });
    pkg(
      "react",
      {
        ".": "react.js",
        "./jsx-runtime": "react-jsx-runtime.js",
        "./jsx-dev-runtime": "react-jsx-dev-runtime.js",
      },
      true,
    );
    pkg("@smthrs/components", { ".": "components.js" });
    pkg("@smthrs/graph", { ".": "graph.js" });
    pkg("@smthrs/scheduler", { ".": "scheduler.js" });
    pkg("drizzle-orm", { "./bun-sqlite": "drizzle-bun-sqlite.js" });
    const hash = (path: string) =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    // Retain the actual bundled dependency provenance and available license notices.
    // The artifact is not a complete general-purpose Smithers distribution.
    const meta =
      typeof result.metafile === "string"
        ? JSON.parse(result.metafile)
        : result.metafile;
    if (!meta?.inputs) throw Error("Missing bundle input provenance");
    const packages = new Map<string, unknown>();
    for (const input of Object.keys(meta.inputs)) {
      let directory = dirname(resolve(process.cwd(), input));
      while (directory.startsWith(`${source}/`)) {
        const manifest = join(directory, "package.json");
        if (existsSync(manifest)) {
          if (packages.has(directory)) break;
          const data = JSON.parse(readFileSync(manifest, "utf8"));
          if (
            typeof data.name !== "string" ||
            typeof data.version !== "string"
          ) {
            directory = dirname(directory);
            continue;
          }
          const id = createHash("sha256")
            .update(relative(source, directory))
            .digest("hex")
            .slice(0, 16);
          const notices: string[] = [];
          for (const name of readdirSync(directory).filter((name) =>
            /^(license|licence|copying|notice)([._-]|$)/i.test(name),
          )) {
            const file = join(directory, name);
            if (!statSync(file).isFile()) continue;
            const destination = join("licenses", id, name);
            mkdirSync(dirname(join(output, destination)), { recursive: true });
            writeFileSync(join(output, destination), readFileSync(file));
            notices.push(destination);
          }
          packages.set(directory, {
            name: data.name,
            version: data.version,
            license: data.license ?? null,
            sourcePath: relative(source, directory),
            packageSha256: hash(manifest),
            notices,
          });
          break;
        }
        directory = dirname(directory);
      }
    }
    writeFileSync(
      join(output, "dependencies.json"),
      `${JSON.stringify([...packages.values()], null, 2)}\n`,
    );
    const compiler = buildWorkflowCompiler(source, output);
    const files: Record<string, string> = {};
    let total = 0;
    function inventory(dir: string) {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name),
          info = lstatSync(p);
        if (info.isSymbolicLink())
          throw Error("Worker artifact must contain physical files");
        if (info.isDirectory()) inventory(p);
        else {
          if (!info.isFile()) throw Error("Unexpected worker resource type");
          const relativePath = relative(output, p).replaceAll("\\", "/");
          if (!/^[A-Za-z0-9@_.+/-]+$/.test(relativePath))
            throw Error("Invalid worker resource path");
          total += info.size;
          if (total > 64 * 1024 * 1024 || Object.keys(files).length >= 4095)
            throw Error("Worker artifact exceeds size/file bounds");
          files[relativePath] = hash(p);
        }
      }
    }
    inventory(output);
    const manifest = {
      version: 1,
      purpose:
        "Reviewed phone workflow worker dependencies; not a general smthrs distribution",
      sourceStampSha256: options.sourceIdentity,
      lockSha256: hash(join(source, "bun.lock")),
      compiler,
      files,
    };
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    if (
      Buffer.byteLength(bytes) > 1024 * 1024 ||
      total + Buffer.byteLength(bytes) > 64 * 1024 * 1024
    )
      throw Error("Worker manifest exceeds bounds");
    writeFileSync(join(output, "manifest.json"), bytes);
    return {
      outputDir: output,
      manifest,
      bytes: total + Buffer.byteLength(bytes),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
