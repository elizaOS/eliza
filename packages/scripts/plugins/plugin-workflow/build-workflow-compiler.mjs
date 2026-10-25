import { resolveMobileWorkflowPackage } from "../../lib/script-metadata.ts";
/** Materialize the compiler's actual declaration graph; never execute workflow drafts. */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
export function buildWorkflowCompiler(source, output) {
  const anchor = join(
      source,
      resolveMobileWorkflowPackage({ repoRoot: source }),
    ),
    require = createRequire(join(anchor, "package.json")),
    ts = require("typescript");
  const compilerRoot = join(output, "compiler"),
    packages = new Map(),
    versions = new Map();
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const write = (file, bytes) => {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && hash(readFileSync(file)) !== hash(bytes))
      throw Error(`Conflicting compiler file: ${relative(output, file)}`);
    writeFileSync(file, bytes);
  };
  const runtime = JSON.parse(
    readFileSync(join(output, "node_modules/smthrs/package.json"), "utf8"),
  );
  const probe = join(anchor, "__eliza_workflow_compiler_probe__.tsx");
  const probeSource =
    Object.keys(runtime.exports)
      .filter((key) => key !== "./package.json")
      .map(
        (key, i) =>
          `import * as surface${i} from ${JSON.stringify(key === "." ? "smthrs" : `smthrs/${key.slice(2)}`)};`,
      )
      .join("\n") +
    `
import {createSmithers} from 'smthrs/create';import {z} from 'zod';
const {Workflow,Task,smithers,outputs}=createSmithers({result:z.object({text:z.string()})},{dbPath:':memory:'});
export default smithers(()=><Workflow name="probe"><Task id="result" output={outputs.result}>{()=>({text:'synthetic'})}</Task></Workflow>);`;
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts"],
    jsx: ts.JsxEmit.ReactJSX,
    jsxImportSource: "smthrs",
  };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...args) =>
    file === probe
      ? ts.createSourceFile(
          file,
          probeSource,
          ts.ScriptTarget.ES2022,
          true,
          ts.ScriptKind.TSX,
        )
      : original(file, ...args);
  host.getCurrentDirectory = () => anchor;
  const program = ts.createProgram([probe], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw Error(
      "Compiler declaration probe failed: " +
        ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " "),
    );
  function owner(file) {
    let dir = dirname(file);
    while (dir !== dirname(dir)) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const data = JSON.parse(readFileSync(manifest, "utf8"));
        if (data.name && data.version) {
          if (
            versions.has(data.name) &&
            versions.get(data.name) !== data.version
          )
            throw Error(
              "Multiple compiler versions require explicit isolation: " +
                data.name,
            );
          versions.set(data.name, data.version);
          if (!packages.has(dir)) {
            const destination =
              data.name === "smthrs"
                ? join(compilerRoot, "types/smthrs")
                : join(compilerRoot, "node_modules", data.name);
            if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(data.name))
              throw Error("Invalid compiler package name");
            write(join(destination, "package.json"), readFileSync(manifest));
            const notices = [];
            for (const name of readdirSync(dir).filter((name) =>
              /^(license|licence|copying|notice)([._-]|$)/i.test(name),
            )) {
              const path = join(dir, name);
              if (statSync(path).isFile()) {
                write(join(destination, name), readFileSync(path));
                notices.push(name);
              }
            }
            packages.set(dir, {
              name: data.name,
              version: data.version,
              license: data.license ?? null,
              sourcePath: relative(source, dir),
              packageSha256: hash(readFileSync(manifest)),
              notices,
              destination,
            });
          }
          return { root: dir, ...packages.get(dir) };
        }
      }
      dir = dirname(dir);
    }
    throw Error(`Compiler input lacks package provenance: ${file}`);
  }
  const files = program
    .getSourceFiles()
    .filter((file) => file.fileName !== probe);
  for (const file of files) {
    const pkg = owner(file.fileName);
    write(
      join(pkg.destination, relative(pkg.root, file.fileName)),
      readFileSync(file.fileName),
    );
    for (
      let dir = dirname(file.fileName);
      dir !== pkg.root;
      dir = dirname(dir)
    ) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest))
        write(
          join(pkg.destination, relative(pkg.root, manifest)),
          readFileSync(manifest),
        );
    }
  }
  const compilerModule = require.resolve("typescript"),
    compilerPackage = owner(compilerModule);
  write(
    join(
      compilerPackage.destination,
      relative(compilerPackage.root, compilerModule),
    ),
    readFileSync(compilerModule),
  );
  const smithersPath = dirname(require.resolve("smthrs/package.json")),
    smithers = owner(join(smithersPath, "src/index.d.ts"));
  const upstream = JSON.parse(
      readFileSync(join(smithersPath, "package.json"), "utf8"),
    ),
    exports = {};
  const narrowed = join(compilerRoot, "node_modules/smthrs");
  for (const [key, entry] of Object.entries(runtime.exports)) {
    if (key === "./package.json") continue;
    const definition = upstream.exports[key] ?? upstream.exports["./*"];
    if (typeof definition?.types !== "string")
      throw Error(`Missing compiler subpath types: ${key}`);
    const declaration = definition.types.replace("*", key.slice(2));
    const actual = join(smithers.destination, declaration);
    if (!existsSync(actual))
      throw Error(`Compiler probe omitted ${declaration}`);
    const ast = ts.createSourceFile(
      "entry.js",
      readFileSync(join(output, "lib", entry.slice(2)), "utf8"),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.JS,
    );
    const names = [];
    for (const node of ast.statements)
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      )
        for (const item of node.exportClause.elements)
          names.push(item.name.text);
    if (!names.length || names.some((name) => !/^[$A-Za-z_][$\w]*$/.test(name)))
      throw Error("Unrecognized bundled export surface");
    const file = key === "." ? "index.d.ts" : `${key.slice(2)}.d.ts`;
    const target = relative(dirname(join(narrowed, file)), actual).replace(
      /\.d\.([cm]?)ts$/,
      ".$1js",
    );
    const specifier = JSON.stringify(
      target.startsWith(".") ? target : `./${target}`,
    );
    write(
      join(narrowed, file),
      `export {${names.join(",")}} from ${specifier};\n` +
        (key === "."
          ? `export type {SmithersWorkflow,AgentGenerateOptions} from ${specifier};\n`
          : ""),
    );
    exports[key] = { types: `./${file}` };
  }
  write(
    join(narrowed, "package.json"),
    JSON.stringify({ name: "smthrs", type: "module", exports }),
  );
  write(
    join(compilerRoot, "dependencies.json"),
    `${JSON.stringify(
      [...packages.values()].map(({ destination, ...pkg }) => pkg),
      null,
      2,
    )}\n`,
  );
  const result = {
    version: 1,
    compilerModule: relative(
      compilerRoot,
      join(
        compilerPackage.destination,
        relative(compilerPackage.root, compilerModule),
      ),
    ),
    declarationFiles: files.length,
    packages: packages.size,
  };
  write(
    join(compilerRoot, "compiler.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}
