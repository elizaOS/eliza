/**
 * Provides descriptor-bound reads and non-evaluating inspection for private
 * provider operator inputs. Callers hash, parse, and import only the bytes
 * returned here so path replacement cannot substitute a second payload.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import process from "node:process";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const NON_EXECUTING_MODULE_INSPECTION = `
import vm from "node:vm";
let source = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) source += chunk;
const requiredExport = process.argv[1];
const module = new vm.SourceTextModule(source);
await module.link(async (specifier) => {
  if (!specifier.startsWith("node:")) throw new Error("unpinned import");
  const namespace = await import(specifier);
  return new vm.SyntheticModule(Object.keys(namespace), function initialize() {
    for (const [name, value] of Object.entries(namespace)) this.setExport(name, value);
  });
});
const exports = Object.getOwnPropertyNames(module.namespace);
if (!exports.includes(requiredExport)) process.exit(4);
`;

export interface StableOperatorFileOptions {
  maxBytes?: number;
  requireCurrentUser?: boolean;
  requirePrivateMode?: boolean;
}

function stableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Open the final path without following links and read one stable descriptor. */
export function readStableOperatorFile(
  file: string,
  label: string,
  options: StableOperatorFileOptions = {},
): Buffer {
  const descriptor = openSync(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error(`${label} must be a single-linked regular file`);
    }
    const uid = process.getuid?.();
    if (
      options.requireCurrentUser === true &&
      uid !== undefined &&
      before.uid !== BigInt(uid)
    ) {
      throw new Error(`${label} must be owned by the current POSIX user`);
    }
    if (options.requirePrivateMode === true && (before.mode & 0o077n) !== 0n) {
      throw new Error(`${label} must not be accessible to group or world`);
    }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`${label} exceeds its ${maxBytes}-byte limit`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !stableIdentity(before, after) ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function rejectRuntimeModuleLoaders(source: string): void {
  const forbidden: readonly [RegExp, string][] = [
    [/\bimport\s*\(/u, "dynamic import"],
    [/\bcreateRequire\b/u, "createRequire"],
    [/(?:^|[^\w$])require\s*\(/u, "require"],
    [/\bprocess\s*\.\s*getBuiltinModule\b/u, "process.getBuiltinModule"],
    [/\bmodule\s*\.\s*register(?:Hooks)?\b/u, "module runtime loader"],
    [/\beval\s*\(/u, "eval"],
    [/\bnew\s+Function\b/u, "Function constructor"],
  ];
  for (const [pattern, name] of forbidden) {
    if (pattern.test(source)) {
      throw new Error(`operator module uses forbidden ${name}`);
    }
  }
}

/** Validate one pinned, self-contained ESM payload without evaluating it. */
export function inspectPinnedSelfContainedModuleBytes(
  bytes: Buffer,
  expectedSha256: string,
  requiredExport: string,
): void {
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("operator module digest mismatch");
  }
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new Error("operator module must be canonical UTF-8 JavaScript");
  }
  if (/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/u.test(source)) {
    throw new Error("operator module must not embed private key material");
  }
  rejectRuntimeModuleLoaders(source);
  const inspection = spawnSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      "--input-type=module",
      "--eval",
      NON_EXECUTING_MODULE_INSPECTION,
      requiredExport,
    ],
    {
      input: bytes,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 10_000,
      env: { NODE_NO_WARNINGS: "1" },
    },
  );
  if (inspection.error || inspection.status !== 0) {
    throw new Error(
      "operator module failed non-executing syntax/export validation or imports unpinned code",
    );
  }
}

/** Validate the authorization-first external-canary capability bundle. */
export function inspectPinnedOperatorModuleBytes(
  bytes: Buffer,
  expectedSha256: string,
): void {
  inspectPinnedSelfContainedModuleBytes(
    bytes,
    expectedSha256,
    "createExternalProviderCanaryCapabilities",
  );
}
