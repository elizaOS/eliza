/** Exercise the built, packed UI API without Vite or TypeScript source aliases. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const output = testOutputPath("ui-public-api");
await mkdir(output, { recursive: true });
const consumer = await mkdtemp(path.join(tmpdir(), "eliza-ui-consumer-"));
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", consumer],
      { cwd: path.join(packageRoot, "dist"), encoding: "utf8" },
    ),
  );
  const files: string[] = packed.files.map(
    (file: { path: string }) => file.path,
  );
  const forbidden = files.filter((file) =>
    /(?:^|\/)(?:testing|storybook|fixtures|__e2e__|__integration__|__screenshots__)(?:\/|$)|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|ChatWidgetHarness|e2e-wallet/.test(
      file,
    ),
  );
  assert.deepEqual(
    forbidden,
    [],
    "Packed UI must not contain development/test infrastructure",
  );
  for (const required of [
    "index.js",
    "index.d.ts",
    "styles.js",
    "cloud-ui/index.css",
    "login/LICENSE",
    "brand/brand.css",
  ]) {
    assert.ok(
      files.includes(required),
      `Missing packed runtime asset: ${required}`,
    );
  }
  assert.ok(
    files.some(
      (file) => file.startsWith("voice/worklets/") && file.endsWith(".js"),
    ),
    "Missing audio worklets",
  );
  assert.ok(
    files.some(
      (file) =>
        file.startsWith("components/views/view-icons/") &&
        file.endsWith(".svg"),
    ),
    "Missing vendored view icons",
  );
  const destination = path.join(consumer, "node_modules/@elizaos/ui");
  await mkdir(destination, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    path.join(consumer, packed.filename),
    "--strip-components=1",
    "-C",
    destination,
  ]);
  // Dependencies use their installed package exports. Only UI is replaced with
  // extracted tarball bytes; no UI source link or tsconfig paths are available.
  const installed = path.join(packageRoot, "node_modules");
  for (const item of await readdir(installed, { withFileTypes: true })) {
    if (item.name.startsWith(".")) continue;
    if (item.name.startsWith("@")) {
      for (const name of await readdir(path.join(installed, item.name))) {
        if (item.name === "@elizaos" && name === "ui") continue;
        const target = path.join(consumer, "node_modules", item.name, name);
        await mkdir(path.dirname(target), { recursive: true });
        await symlink(
          await realpath(path.join(installed, item.name, name)),
          target,
          "dir",
        );
      }
    } else {
      await symlink(
        await realpath(path.join(installed, item.name)),
        path.join(consumer, "node_modules", item.name),
        "dir",
      );
    }
  }
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const require = createRequire(path.join(consumer, "consumer.mjs"));
  assert.equal(
    require.resolve("@elizaos/ui"),
    await realpath(path.join(destination, "index.js")),
  );
  for (const removed of [
    "api",
    "state",
    "browser",
    "components/ui/button",
    "storybook/mock-providers",
  ]) {
    assert.throws(() => require.resolve(`@elizaos/ui/${removed}`), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
  }
  const source = await readFile(path.join(packageRoot, "src/index.ts"), "utf8");
  const ast = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const types: string[] = [];
  const values: string[] = [];
  for (const node of ast.statements) {
    assert.ok(
      ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause),
      "Root API must explicitly name its exports",
    );
    for (const entry of node.exportClause.elements)
      (node.isTypeOnly || entry.isTypeOnly ? types : values).push(
        entry.name.text,
      );
  }
  const consumerSource = `import { ${values.join(", ")}${types.length ? `, ${types.map((name) => `type ${name}`).join(", ")}` : ""} } from "@elizaos/ui";\nexport const values = { ${values.join(", ")} };\nexport type { ${types.join(", ")} };\n`;
  await writeFile(path.join(consumer, "consumer.ts"), consumerSource);
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node", "vite/client"],
      },
      files: ["consumer.ts"],
    }),
  );
  const configPath = path.join(consumer, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, consumer);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  // Check every declaration we publish and the real consumer. Third-party
  // declaration internals are owned by their packages; report them separately.
  const uiRoot = await realpath(destination);
  const consumerRoot = await realpath(consumer);
  const ownedDiagnostics = diagnostics.filter((diagnostic) => {
    if (!diagnostic.file) return true;
    const filename =
      ts.sys.realpath?.(diagnostic.file.fileName) ?? diagnostic.file.fileName;
    return (
      filename.startsWith(`${uiRoot}${path.sep}`) ||
      filename === path.join(consumerRoot, "consumer.ts")
    );
  });
  assert.equal(
    ownedDiagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(ownedDiagnostics, {
      getCanonicalFileName: (filename) => filename,
      getCurrentDirectory: () => consumer,
      getNewLine: () => "\n",
    }),
  );
  await writeFile(
    path.join(output, "dependency-type-diagnostics.txt"),
    ts.formatDiagnosticsWithColorAndContext(
      diagnostics.filter(
        (diagnostic) => !ownedDiagnostics.includes(diagnostic),
      ),
      {
        getCanonicalFileName: (filename) => filename,
        getCurrentDirectory: () => consumer,
        getNewLine: () => "\n",
      },
    ),
  );
  const exportNames = async (entry: string) => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      packages: "external",
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      splitting: true,
      outdir: path.join(consumer, "bundle"),
      loader: {
        ".css": "empty",
        ".svg": "dataurl",
        ".png": "dataurl",
        ".wav": "dataurl",
      },
      logLevel: "silent",
    });
    const outputs = result.metafile.outputs;
    const resolvedEntry = await realpath(entry);
    const initial: string[] = [];
    for (const [file, metadata] of Object.entries(outputs)) {
      if (
        metadata.entryPoint &&
        (await realpath(path.resolve(metadata.entryPoint))) === resolvedEntry
      )
        initial.push(file);
    }
    assert.equal(initial.length, 1, "Expected one root entry chunk");
    const visited = new Set<string>();
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const input of Object.keys(outputs[file].inputs)) {
        assert.ok(
          !/cloud\/(?:instances|analytics|home|billing|api-keys|organization|admin)\/(?:index|routes)\.[jt]sx?$/.test(
            input,
          ),
          `Private Cloud registration in initial root chunk: ${input}`,
        );
      }
      for (const dependency of outputs[file].imports) {
        if (!dependency.external && dependency.kind !== "dynamic-import")
          visit(dependency.path);
      }
    };
    visit(initial[0]);
    return outputs[initial[0]].exports.sort();
  };
  assert.deepEqual(
    await exportNames(path.join(packageRoot, "src/index.ts")),
    await exportNames(path.join(destination, "index.js")),
    "Source and packed runtime exports differ",
  );
  await writeFile(
    path.join(output, "report.json"),
    `${JSON.stringify(
      {
        package: manifest.name,
        files: files.length,
        values: values.length,
        types: types.length,
        packedConsumer: "passed",
        sourceBuiltParity: "passed",
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Packed UI API verified: ${values.length} values, ${types.length} types, ${files.length} files.`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
