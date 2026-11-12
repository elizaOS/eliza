import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

// Explicit build entry point: no package-install hook, download, or compilation on import.
const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(here, "sources.json")));
const [outputArg, headersArg, target = "linux-x64", compiler = "/usr/bin/cc"] =
  process.argv.slice(2);
if (
  !outputArg ||
  !headersArg ||
  !isAbsolute(compiler) ||
  !["linux-x64", "x86_64-linux-musl", "aarch64-linux-musl"].includes(target)
)
  throw new Error(
    "Usage: node build.mjs OUTPUT NODE_24_15_0_INCLUDE [linux-x64|x86_64-linux-musl|aarch64-linux-musl] /absolute/compiler",
  );
// An absolute `zig` binary is a complete cross toolchain for the musl targets: the build
// writes `zig cc -target`, `zig ar` and `zig ranlib` drivers for it.
const zig = basename(compiler) === "zig";
if (zig && target === "linux-x64")
  throw new Error("A zig toolchain builds only the musl targets");
const output = resolve(outputArg),
  headers = resolve(headersArg);
const headerVersion = readFileSync(join(headers, "node_version.h"), "utf8");
for (const [part, expected] of Object.entries({
  MAJOR: 24,
  MINOR: 15,
  PATCH: 0,
}))
  if (
    !new RegExp(`#define NODE_${part}_VERSION\\s+${expected}\\b`).test(
      headerVersion,
    )
  )
    throw new Error("Pinned Node headers required");
mkdirSync(output, { recursive: true });
let cc = compiler;
const toolchainEnv = {};
if (zig) {
  const tools = join(output, "toolchain");
  mkdirSync(tools, { recursive: true });
  const quoted = `'${compiler.replaceAll("'", "'\\''")}'`;
  const driver = (name, command) => {
    const file = join(tools, `${target}-${name}`);
    writeFileSync(file, `#!/bin/sh\nexec ${quoted} ${command} "$@"\n`, {
      mode: 0o755,
    });
    return file;
  };
  cc = driver("cc", `cc -target ${target}`);
  // The host archiver (BSD ar on macOS) writes no symbol index for ELF objects.
  toolchainEnv.AR = driver("ar", "ar");
  toolchainEnv.RANLIB = driver("ranlib", "ranlib");
  toolchainEnv.PATH = `${tools}${delimiter}${process.env.PATH}`;
}
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (command, args, cwd = output, env = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...toolchainEnv, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Build command failed: ${command}`);
};
const sources = join(output, "sources");
mkdirSync(sources, { recursive: true });
for (const [name, pin] of Object.entries(pins)) {
  if (!pin.url) continue;
  const archive = join(sources, `${name}.tar.gz`);
  if (!existsSync(archive)) {
    const response = await fetch(pin.url);
    if (!response.ok) throw new Error(`Source download failed: ${name}`);
    writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
  }
  if (hash(archive) !== pin.sha256)
    throw new Error(`Pinned source hash mismatch: ${name}`);
  if (existsSync(join(sources, pin.directory)))
    throw new Error(
      `Refuse dirty/reused extracted source: ${name}; use a fresh output directory`,
    );
  run("tar", ["-xzf", archive, "-C", sources]);
}
const cryptoSource = join(sources, pins.openssl.directory),
  cipherSource = join(sources, pins.sqlcipher.directory);
const machine = target === "aarch64-linux-musl" ? 183 : 62;
const cryptoOutput = join(output, "crypto");
run(
  "perl",
  [
    "Configure",
    machine === 183 ? "linux-aarch64" : "linux-x86_64",
    "no-shared",
    "no-tests",
    "no-apps",
    "no-asm",
    "no-module",
    "no-dso",
    "no-legacy",
    `--prefix=${cryptoOutput}`,
    "-fPIC",
    "-fvisibility=hidden",
  ],
  cryptoSource,
  { CC: cc },
);
run("make", ["-j1", "build_libs"], cryptoSource);
// Headers are generated in-tree; use the exact static archive, never -lcrypto lookup.
const cryptoArchive = join(cryptoSource, "libcrypto.a");
const configure = [
  "--disable-shared",
  "--disable-tcl",
  "--with-tempstore=always",
];
if (target !== "linux-x64") configure.push(`--host=${target}`);
run("sh", ["configure", ...configure], cipherSource, {
  CC: cc,
  CFLAGS:
    "-fPIC -DSQLITE_HAS_CODEC -DSQLITE_EXTRA_INIT=sqlcipher_extra_init -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown",
  CPPFLAGS: `-I${join(cryptoSource, "include")}`,
  LDFLAGS: cryptoArchive,
});
run("make", ["-j1", "sqlite3.c"], cipherSource);
const library = join(output, "libeliza_task_sqlcipher.so");
const flags = [
  "-std=c11",
  "-O2",
  "-fPIC",
  "-fvisibility=hidden",
  "-shared",
  "-DNAPI_VERSION=8",
  "-DNODE_GYP_MODULE_NAME=eliza_task_sqlcipher",
  `-DELIZA_SQLCIPHER_VERSION="${pins.sqlcipher.version}"`,
  "-DSQLITE_HAS_CODEC",
  "-DSQLITE_EXTRA_INIT=sqlcipher_extra_init",
  "-DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown",
  "-DSQLITE_THREADSAFE=1",
  "-DSQLITE_TEMP_STORE=3",
  "-DSQLITE_OMIT_LOAD_EXTENSION",
  "-DSQLITE_DEFAULT_MEMSTATUS=0",
  "-DSQLITE_DQS=0",
  "-D_GNU_SOURCE",
  `-I${headers}`,
  `-I${cipherSource}`,
  `-I${join(cryptoSource, "include")}`,
  join(here, "driver.c"),
  join(cipherSource, "sqlite3.c"),
  cryptoArchive,
  "-pthread",
  "-ldl",
  "-lm",
  "-Wl,-Bsymbolic",
  // zig's linker has no --exclude-libs. The version script already keeps every symbol
  // local except the two N-API ones, and the nm check below enforces that.
  ...(zig ? [] : ["-Wl,--exclude-libs,ALL"]),
  `-Wl,--version-script=${join(here, "exports.map")}`,
  "-o",
  library,
];
run(cc, flags);
const elf = readFileSync(library);
if (
  elf.toString("hex", 0, 6) !== "7f454c460201" ||
  elf.readUInt16LE(18) !== machine
)
  throw new Error("Built ELF target mismatch");
const symbols = spawnSync("nm", ["-D", "--defined-only", library], {
  encoding: "utf8",
});
if (
  symbols.status ||
  symbols.stdout
    .split("\n")
    .filter(Boolean)
    .some(
      (line) =>
        !/\b(napi_register_module_v1|node_api_module_get_api_version_v1)$/.test(
          line,
        ),
    )
)
  throw new Error("Unexpected exported native symbols");
const notices = join(output, "licenses");
mkdirSync(notices);
copyFileSync(
  join(cipherSource, "LICENSE.md"),
  join(notices, "SQLCipher-LICENSE.md"),
);
copyFileSync(
  join(cryptoSource, "LICENSE.txt"),
  join(notices, "OpenSSL-LICENSE.txt"),
);
if (existsSync(join(cryptoSource, "NOTICE.txt")))
  copyFileSync(
    join(cryptoSource, "NOTICE.txt"),
    join(notices, "OpenSSL-NOTICE.txt"),
  );
writeFileSync(
  join(output, "build.json"),
  `${JSON.stringify(
    {
      target,
      machine,
      pins,
      library,
      sha256: hash(library),
      compiler,
      compilerSha256: hash(compiler),
      ...(zig
        ? {
            zigVersion: spawnSync(compiler, ["version"], {
              encoding: "utf8",
            }).stdout.trim(),
          }
        : {}),
      flags,
      driverSha256: hash(join(here, "driver.c")),
      writerLeaseSha256: hash(join(here, "writer-lease.h")),
      nodeHeaders: [
        "node_api.h",
        "js_native_api.h",
        "js_native_api_types.h",
        "node_api_types.h",
        "node_version.h",
      ].map((name) => ({ name, sha256: hash(join(headers, name)) })),
      runtimeQualified: false,
    },
    null,
    2,
  )}\n`,
);
