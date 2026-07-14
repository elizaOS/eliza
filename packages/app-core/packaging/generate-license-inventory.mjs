#!/usr/bin/env node
/**
 * Materializes legal evidence from an exact prepared package runtime.
 * Distribution builders verify the assembler's immutable dependency inventory
 * against the final filesystem, retain every bundled license/notice byte, and
 * fail when a component has no license expression or artifact-local text. The
 * resulting files travel unchanged in Debian, Snap, and Flatpak artifacts.
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INVENTORY_SCHEMA_VERSION = 2;
const RUNTIME_DEPENDENCY_INVENTORY_FILE = "elizaos-runtime-dependencies.json";
const RUNTIME_DEPENDENCY_INVENTORY_SCHEMA_VERSION = 1;
const LICENSE_FILE_PATTERN = /^(?:license|licence|copying|notice)(?:$|[._-])/iu;
const PROJECT_PACKAGE_PREFIX = "@elizaos/";
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu;
const REVIEWED_LICENSE_OVERRIDES = new Map([
  [
    "@bufbuild/protobuf@2.12.1",
    {
      expression: "(Apache-2.0 AND BSD-3-Clause)",
      evidenceSource:
        "https://github.com/bufbuild/protobuf-es/blob/v2.12.1/LICENSE plus the Google Protocol Buffers BSD-3-Clause license the runtime derives from (https://github.com/protocolbuffers/protobuf/blob/v29.1/LICENSE); the npm tarball ships no license text",
      expectedSha256:
        "a007310d98d9309f3f8c72dafa3061f0b0d3524679a2177868401a3d9595602d",
      repositoryPath:
        "packages/app-core/packaging/licenses/bufbuild-protobuf-2.12.1-Apache-2.0-AND-BSD-3-Clause.txt",
      runtimePath:
        "licenses/bufbuild-protobuf-2.12.1-Apache-2.0-AND-BSD-3-Clause.txt",
    },
  ],
  [
    "buffers@0.1.1",
    {
      expression: "MIT",
      evidenceSource:
        "https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/",
      expectedSha256:
        "c9600edd9689e21e8c7365ac33ca1ae5eaddd97f17d29800e6c8bc2e920423a3",
      repositoryPath:
        "packages/app-core/packaging/licenses/buffers-0.1.1-MIT.txt",
      runtimePath: "licenses/buffers-0.1.1-MIT.txt",
    },
  ],
  [
    "@metamask/eth-json-rpc-provider@1.0.1",
    {
      expression: "ISC",
      evidenceSource:
        "https://github.com/MetaMask/eth-json-rpc-provider/blob/69d7d5d073de339766117658ea23293870a45e11/LICENSE",
      expectedSha256:
        "0b03e62ba9941c1bdffe61b5e45b9e9d9e4c7c9ad18609ab879fd481eb2916f4",
      repositoryPath:
        "packages/app-core/packaging/licenses/metamask-eth-json-rpc-provider-1.0.1-ISC.txt",
      runtimePath: "licenses/metamask-eth-json-rpc-provider-1.0.1-ISC.txt",
    },
  ],
  [
    "@lit-labs/ssr-dom-shim@1.6.0",
    {
      expression: "BSD-3-Clause",
      evidenceSource:
        "https://github.com/lit/lit/blob/20afabd3c5bfd49fdcdf1b8518e05c7f99a46db6/LICENSE",
      expectedSha256:
        "45d31799d0db956cc3eb5469346abbd9b7025babc5ff29fab10d7095da992ef1",
      repositoryParts: [
        {
          path: "packages/app-core/packaging/licenses/lit-ssr-dom-shim-1.6.0-BSD-3-Clause.txt",
          sha256:
            "2b66f9390afde29edfe4314daff93f01fb182e1178053e228120178987e5db75",
        },
      ],
      stripFinalNewline: true,
      runtimePath: "licenses/lit-ssr-dom-shim-1.6.0-BSD-3-Clause.txt",
    },
  ],
  [
    "encode-utf8@1.0.3",
    {
      expression: "MIT",
      evidenceSource:
        "https://github.com/LinusU/encode-utf8/blob/87cba02f7ddf8792f2e60c4b1a7c1eccf6daa3d2/LICENCE",
      expectedSha256:
        "48f761956f2709d24a8750e2fd37cf347f421125d625f48a53f03d72834d2ab8",
      repositoryPath:
        "packages/app-core/packaging/licenses/encode-utf8-1.0.3-MIT.txt",
      runtimePath: "licenses/encode-utf8-1.0.3-MIT.txt",
    },
  ],
  [
    "tr46@6.0.0",
    {
      expression: "MIT",
      evidenceSource:
        "https://github.com/jsdom/tr46/blob/7f1eb920768c794be40962a4f0cbad670a398d04/LICENSE.md",
      expectedSha256:
        "499d6d466d064e0460427967a344e2a32fcb86ea8c6cd1a285ec4f1fa03fba67",
      repositoryPath: "packages/app-core/packaging/licenses/tr46-6.0.0-MIT.txt",
      runtimePath: "licenses/tr46-6.0.0-MIT.txt",
    },
  ],
  [
    "uint8arrays@3.1.0",
    {
      expression: "MIT",
      evidenceSource:
        "https://github.com/achingbrain/uint8arrays/blob/4756683ff96a52f463e9b3514d49a0dceec7ca9c/LICENSE-MIT",
      expectedSha256:
        "8f71659370c5268d9a1dc962a46232540e8fca63462586d8efaa95aab492a208",
      repositoryPath:
        "packages/app-core/packaging/licenses/uint8arrays-3.1.0-MIT.txt",
      runtimePath: "licenses/uint8arrays-3.1.0-MIT.txt",
    },
  ],
  [
    "rpc-websockets@9.3.9",
    {
      expression: "LGPL-3.0-only",
      evidenceSource:
        "https://github.com/elpheria/rpc-websockets/tree/af8980776b55c2320b790556f775266fd5afc3ce",
      expectedSha256:
        "b047f268756b731a3d50aa3c3c031c735580aed1e2b8135d880e639e936ba1ad",
      repositoryParts: [
        {
          path: "packages/app-core/packaging/licenses/rpc-websockets-9.3.9-NOTICE.txt",
          sha256:
            "8968d5625b976795e8f58545c3a6c69f1af9a21283b6edc71c9bc744e456e7f6",
        },
        {
          path: "packages/app-core/packaging/licenses/GNU-LGPL-3.0.txt",
          sha256:
            "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118",
        },
        {
          path: "packages/os/linux/tails/COPYING",
          sha256:
            "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
        },
      ],
      runtimePath: "licenses/rpc-websockets-9.3.9-LGPL-3.0-only-COMPLETE.txt",
    },
  ],
]);

const LICENSE_POLICY_RANK = {
  allow: 0,
  "obligation-reviewed": 1,
  prohibited: 2,
};
const PERMISSIVE_LICENSE_PATTERN =
  /^(?:0BSD|AFL-2\.1|APACHE-2\.0|BSD|BSD-[234]-CLAUSE|BLUEOAK-1\.0\.0|CC0-1\.0|ISC|MIT|MIT-0|MIT\/X11|PYTHON-2\.0|UNLICENSE|ZLIB)$/u;
const OBLIGATION_LICENSE_PATTERN =
  /^(?:CC-BY-4\.0|CDDL-[0-9.]+|EPL-[0-9.]+|GPL-[0-9.]+(?:-ONLY|-OR-LATER)?|LGPL-[0-9.]+(?:-ONLY|-OR-LATER)?|MPL-[0-9.]+|OFL-1\.1)$/u;
const PROHIBITED_LICENSE_PATTERN =
  /^(?:AGPL-[0-9.]+(?:-ONLY|-OR-LATER)?|BUSL-[0-9.]+|CC-BY-(?:NC|ND)(?:-[A-Z]+)?-[0-9.]+|ELASTIC-[0-9.]+|JSON|RSALV?2?|SSPL-[0-9.]+|UNLICENSED)$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertRegularFile(path, label) {
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (!status?.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

function isWithinRoot(root, candidate) {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

function installNameFromRecordPath(recordPath, manifestName) {
  const segments = recordPath.split("/");
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  if (nodeModulesIndex < 0) return manifestName;

  const first = segments[nodeModulesIndex + 1];
  const scoped = first?.startsWith("@");
  const expectedLength = nodeModulesIndex + (scoped ? 3 : 2);
  if (
    !first ||
    segments.length !== expectedLength ||
    (scoped && !segments[nodeModulesIndex + 2])
  ) {
    throw new Error(
      `Dependency inventory path has no exact package install name: ${recordPath}`,
    );
  }
  return scoped ? `${first}/${segments[nodeModulesIndex + 2]}` : first;
}

export function digestPackagePayload(packageRoot) {
  const digest = createHash("sha256");
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (entry.name === "node_modules") continue;
      const entryPath = join(directory, entry.name);
      const entryRelative = join(relativeDirectory, entry.name)
        .split(sep)
        .join("/");
      const status = lstatSync(entryPath);
      if (status.isDirectory()) {
        digest.update(`directory\0${entryRelative}\0${status.mode}\0`);
        visit(entryPath, entryRelative);
      } else if (status.isFile()) {
        digest.update(`file\0${entryRelative}\0${status.mode}\0`);
        digest.update(readFileSync(entryPath));
      } else if (status.isSymbolicLink()) {
        digest.update(
          `symlink\0${entryRelative}\0${status.mode}\0${readlinkSync(entryPath)}\0`,
        );
      } else {
        throw new Error(
          `Runtime package contains unsupported payload entry: ${entryRelative}`,
        );
      }
    }
  };
  visit(packageRoot, "");
  return digest.digest("hex");
}

function collectRuntimePackagePaths(runtimeRoot) {
  const canonicalRoot = realpathSync(runtimeRoot);
  const packagePaths = new Set();
  const visitedPackageRoots = new Set();
  const visitedNodeModules = new Set();

  function inspectPackage(packageEntry) {
    const status = lstatSync(packageEntry, { throwIfNoEntry: false });
    if (!status || (!status.isDirectory() && !status.isSymbolicLink())) {
      throw new Error(`Runtime package entry is invalid: ${packageEntry}`);
    }
    const packageRoot = realpathSync(packageEntry);
    if (!isWithinRoot(canonicalRoot, packageRoot)) {
      throw new Error(`Runtime package escapes its root: ${packageEntry}`);
    }
    if (visitedPackageRoots.has(packageRoot)) return;
    visitedPackageRoots.add(packageRoot);

    assertRegularFile(
      join(packageRoot, "package.json"),
      "runtime package manifest",
    );
    packagePaths.add(relative(canonicalRoot, packageRoot).split(sep).join("/"));
    inspectNodeModules(join(packageRoot, "node_modules"));
  }

  function inspectNodeModules(nodeModulesEntry) {
    const status = lstatSync(nodeModulesEntry, { throwIfNoEntry: false });
    if (!status) return;
    if (!status.isDirectory() && !status.isSymbolicLink()) {
      throw new Error(
        `Runtime node_modules entry is invalid: ${nodeModulesEntry}`,
      );
    }
    const nodeModulesRoot = realpathSync(nodeModulesEntry);
    if (!isWithinRoot(canonicalRoot, nodeModulesRoot)) {
      throw new Error(
        `Runtime node_modules escapes its root: ${nodeModulesEntry}`,
      );
    }
    if (visitedNodeModules.has(nodeModulesRoot)) return;
    visitedNodeModules.add(nodeModulesRoot);

    for (const entry of readdirSync(nodeModulesRoot, {
      withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(nodeModulesRoot, entry.name);
      if (entry.name.startsWith("@")) {
        const scopeStatus = lstatSync(entryPath);
        if (!scopeStatus.isDirectory() || scopeStatus.isSymbolicLink()) {
          throw new Error(`Runtime package scope is invalid: ${entryPath}`);
        }
        for (const scopedEntry of readdirSync(entryPath, {
          withFileTypes: true,
        }).sort((left, right) => left.name.localeCompare(right.name))) {
          if (!scopedEntry.name.startsWith(".")) {
            inspectPackage(join(entryPath, scopedEntry.name));
          }
        }
      } else {
        inspectPackage(entryPath);
      }
    }
  }

  inspectNodeModules(join(canonicalRoot, "node_modules"));
  return [...packagePaths].sort((left, right) => left.localeCompare(right));
}

function manifestLicense(manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim()) {
    return manifest.license.trim();
  }
  if (
    manifest.license &&
    typeof manifest.license === "object" &&
    typeof manifest.license.type === "string" &&
    manifest.license.type.trim()
  ) {
    return manifest.license.type.trim();
  }
  if (!Array.isArray(manifest.licenses)) return undefined;
  const expressions = manifest.licenses
    .map((license) => {
      if (typeof license === "string") return license.trim();
      if (
        license &&
        typeof license === "object" &&
        typeof license.type === "string"
      ) {
        return license.type.trim();
      }
      return "";
    })
    .filter(Boolean);
  return expressions.length > 0
    ? [...new Set(expressions)].join(" OR ")
    : undefined;
}

function mergeLicensePolicies(operator, policies) {
  const ranks = policies.map((policy) => LICENSE_POLICY_RANK[policy]);
  const selectedRank =
    operator === "OR" ? Math.min(...ranks) : Math.max(...ranks);
  return Object.entries(LICENSE_POLICY_RANK).find(
    ([, rank]) => rank === selectedRank,
  )?.[0];
}

function classifyLicenseIdentifier(identifier) {
  const normalized = identifier.trim().toUpperCase();
  if (PERMISSIVE_LICENSE_PATTERN.test(normalized)) return "allow";
  if (OBLIGATION_LICENSE_PATTERN.test(normalized)) {
    return "obligation-reviewed";
  }
  if (PROHIBITED_LICENSE_PATTERN.test(normalized)) return "prohibited";
  throw new Error(
    `License policy does not recognize identifier: ${identifier}`,
  );
}

/**
 * Classifies an SPDX-style expression using license-choice semantics: every
 * term of an AND branch applies, while any compliant OR branch may be chosen.
 * File-referenced declarations remain obligation-bearing because their exact
 * text is retained for human review; known non-commercial, network-copyleft,
 * source-available, and unlicensed terms are rejected.
 */
export function classifyLicensePolicy(expression) {
  const trimmed = expression.trim();
  const upper = trimmed.toUpperCase();
  if (upper === "NOASSERTION" || upper.startsWith("SEE LICENSE")) {
    return "obligation-reviewed";
  }
  if (upper === "PUBLIC DOMAIN") return "allow";
  if (
    upper.includes("REDIS SOURCE AVAILABLE LICENSE") ||
    upper.includes("COMMONS CLAUSE") ||
    upper.includes("POLYFORM") ||
    upper.includes("PROPRIETARY")
  ) {
    return "prohibited";
  }

  const tokens = trimmed.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/giu);
  if (!tokens || tokens.length === 0) {
    throw new Error("License policy received an empty expression");
  }
  let cursor = 0;

  function parsePrimary() {
    const token = tokens[cursor];
    if (token === "(") {
      cursor += 1;
      const nested = parseOr();
      if (tokens[cursor] !== ")") {
        throw new Error(
          `License policy expression has unmatched parentheses: ${expression}`,
        );
      }
      cursor += 1;
      return nested;
    }
    if (!token || token === ")" || /^(?:AND|OR|WITH)$/iu.test(token)) {
      throw new Error(`License policy expression is malformed: ${expression}`);
    }
    cursor += 1;
    const policy = classifyLicenseIdentifier(
      token.replace(/\+$/u, "-or-later"),
    );
    if (tokens[cursor]?.toUpperCase() === "WITH") {
      cursor += 1;
      const exception = tokens[cursor];
      if (!exception || /^(?:\(|\)|AND|OR|WITH)$/iu.test(exception)) {
        throw new Error(`License policy exception is malformed: ${expression}`);
      }
      cursor += 1;
    }
    return policy;
  }

  function parseAnd() {
    const policies = [parsePrimary()];
    while (tokens[cursor]?.toUpperCase() === "AND") {
      cursor += 1;
      policies.push(parsePrimary());
    }
    return mergeLicensePolicies("AND", policies);
  }

  function parseOr() {
    const policies = [parseAnd()];
    while (tokens[cursor]?.toUpperCase() === "OR") {
      cursor += 1;
      policies.push(parseAnd());
    }
    return mergeLicensePolicies("OR", policies);
  }

  const policy = parseOr();
  if (cursor !== tokens.length) {
    throw new Error(`License policy expression is malformed: ${expression}`);
  }
  return policy;
}

export function collectLicenseFiles(packageRoot) {
  const matches = [];

  function walk(directory, insideLicenseDirectory = false) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (insideLicenseDirectory || LICENSE_FILE_PATTERN.test(entry.name)) {
          throw new Error(`License evidence must not be a symlink: ${path}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        // Nested dependencies have their own lock entry and must not be
        // attributed to the package that happens to contain them.
        if (entry.name !== "node_modules") {
          walk(
            path,
            insideLicenseDirectory || /^licenses?$/iu.test(entry.name),
          );
        }
        continue;
      }
      if (
        entry.isFile() &&
        (insideLicenseDirectory || LICENSE_FILE_PATTERN.test(entry.name))
      ) {
        matches.push(path);
      }
    }
  }

  walk(packageRoot);
  return matches.sort((left, right) => left.localeCompare(right));
}

function encodeLicenseText(bytes) {
  try {
    return {
      encoding: "utf8",
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    // error-policy:J3 byte-preserving base64 is the explicit representation
    // for a license file that is not valid UTF-8.
    return { encoding: "base64", content: bytes.toString("base64") };
  }
}

function retainLicenseText(licenseTexts, bytes) {
  const digest = sha256(bytes);
  if (!licenseTexts.has(digest)) {
    licenseTexts.set(digest, {
      sha256: digest,
      ...encodeLicenseText(bytes),
    });
  }
  return digest;
}

function materializeReviewedLicenseEvidence(runtimeRoot, repositoryRoot) {
  for (const override of REVIEWED_LICENSE_OVERRIDES.values()) {
    const repositoryParts = override.repositoryParts ?? [
      {
        path: override.repositoryPath,
        sha256: override.expectedSha256,
      },
    ];
    const sourceChunks = [];
    for (const [index, part] of repositoryParts.entries()) {
      if (typeof part.path !== "string" || typeof part.sha256 !== "string") {
        throw new Error("Reviewed license evidence part is invalid");
      }
      const sourcePath = join(repositoryRoot, part.path);
      assertRegularFile(sourcePath, "reviewed repository license evidence");
      const partBytes = readFileSync(sourcePath);
      if (partBytes.length === 0) {
        throw new Error(`Reviewed license evidence is empty: ${sourcePath}`);
      }
      const sourceSha256 = sha256(partBytes);
      if (sourceSha256 !== part.sha256) {
        throw new Error(
          `Reviewed license evidence digest differs for ${sourcePath}: expected ${part.sha256}, received ${sourceSha256}`,
        );
      }
      if (index > 0) sourceChunks.push(Buffer.from("\n\n", "utf8"));
      sourceChunks.push(partBytes);
    }
    let sourceBytes = Buffer.concat(sourceChunks);
    if (override.stripFinalNewline && sourceBytes.at(-1) === 0x0a) {
      sourceBytes = sourceBytes.subarray(0, -1);
    }
    const sourceSha256 = sha256(sourceBytes);
    if (sourceSha256 !== override.expectedSha256) {
      throw new Error(
        `Combined reviewed license evidence digest differs for ${override.runtimePath}: expected ${override.expectedSha256}, received ${sourceSha256}`,
      );
    }

    const targetPath = join(runtimeRoot, override.runtimePath);
    const targetDirectory = dirname(targetPath);
    const directoryStatus = lstatSync(targetDirectory, {
      throwIfNoEntry: false,
    });
    if (directoryStatus) {
      if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
        throw new Error(
          `Runtime license evidence directory is invalid: ${targetDirectory}`,
        );
      }
    } else {
      mkdirSync(targetDirectory, { recursive: true });
    }
    const targetStatus = lstatSync(targetPath, { throwIfNoEntry: false });
    if (
      targetStatus &&
      (!targetStatus.isFile() || targetStatus.isSymbolicLink())
    ) {
      throw new Error(
        `Runtime license evidence path is invalid: ${targetPath}`,
      );
    }
    writeFileSync(targetPath, sourceBytes);
  }
}

export function createInventory(runtimeRoot, repositoryRoot) {
  const runtimeManifestPath = join(runtimeRoot, "package.json");
  const projectLicensePath = join(repositoryRoot, "LICENSE");
  assertRegularFile(runtimeManifestPath, "prepared runtime manifest");
  assertRegularFile(projectLicensePath, "repository license");

  const runtimeManifest = readJson(runtimeManifestPath);
  const sourceLockSha256 = runtimeManifest.elizaosRuntime?.sourceLockSha256;
  if (
    typeof sourceLockSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sourceLockSha256)
  ) {
    throw new Error("Prepared runtime is missing its source-lock digest");
  }

  const inventoryMetadata = runtimeManifest.elizaosRuntime?.dependencyInventory;
  if (
    !inventoryMetadata ||
    typeof inventoryMetadata !== "object" ||
    inventoryMetadata.file !== RUNTIME_DEPENDENCY_INVENTORY_FILE ||
    typeof inventoryMetadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(inventoryMetadata.sha256) ||
    typeof inventoryMetadata.packagesSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(inventoryMetadata.packagesSha256) ||
    !Number.isSafeInteger(inventoryMetadata.packageCount) ||
    inventoryMetadata.packageCount < 1
  ) {
    throw new Error(
      "Prepared runtime has invalid dependency inventory metadata",
    );
  }
  const dependencyInventoryPath = join(
    runtimeRoot,
    RUNTIME_DEPENDENCY_INVENTORY_FILE,
  );
  assertRegularFile(
    dependencyInventoryPath,
    "prepared runtime dependency inventory",
  );
  const dependencyInventoryBytes = readFileSync(dependencyInventoryPath);
  if (sha256(dependencyInventoryBytes) !== inventoryMetadata.sha256) {
    throw new Error("Prepared runtime dependency inventory digest differs");
  }
  const dependencyInventory = JSON.parse(
    dependencyInventoryBytes.toString("utf8"),
  );
  if (
    !dependencyInventory ||
    typeof dependencyInventory !== "object" ||
    dependencyInventory.schemaVersion !==
      RUNTIME_DEPENDENCY_INVENTORY_SCHEMA_VERSION ||
    dependencyInventory.generatedFrom !== "frozen-bun-install" ||
    dependencyInventory.sourceLockSha256 !== sourceLockSha256 ||
    dependencyInventory.packageCount !== inventoryMetadata.packageCount ||
    dependencyInventory.packagesSha256 !== inventoryMetadata.packagesSha256 ||
    !Array.isArray(dependencyInventory.packages) ||
    dependencyInventory.packages.length !== inventoryMetadata.packageCount ||
    sha256(JSON.stringify(dependencyInventory.packages)) !==
      inventoryMetadata.packagesSha256
  ) {
    throw new Error("Prepared runtime dependency inventory is inconsistent");
  }

  const observedPackagePaths = collectRuntimePackagePaths(runtimeRoot);
  const inventoryPackagePaths = dependencyInventory.packages.map((entry) =>
    typeof entry?.path === "string" ? entry.path : "",
  );
  if (
    JSON.stringify(inventoryPackagePaths) !==
    JSON.stringify(observedPackagePaths)
  ) {
    throw new Error(
      `Prepared runtime dependency set differs; inventory=${JSON.stringify(inventoryPackagePaths)}, observed=${JSON.stringify(observedPackagePaths)}`,
    );
  }

  const licenseTexts = new Map();
  const packages = [];
  const entries = dependencyInventory.packages;
  if (entries.length === 0) {
    throw new Error("Prepared runtime dependency closure is empty");
  }

  for (const dependencyRecord of entries) {
    if (
      !dependencyRecord ||
      typeof dependencyRecord !== "object" ||
      typeof dependencyRecord.path !== "string" ||
      dependencyRecord.path.length === 0 ||
      dependencyRecord.path.includes("\\") ||
      dependencyRecord.path
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ) ||
      typeof dependencyRecord.installName !== "string" ||
      !PACKAGE_NAME_PATTERN.test(dependencyRecord.installName) ||
      typeof dependencyRecord.name !== "string" ||
      !PACKAGE_NAME_PATTERN.test(dependencyRecord.name) ||
      typeof dependencyRecord.version !== "string" ||
      typeof dependencyRecord.packageJsonSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(dependencyRecord.packageJsonSha256) ||
      typeof dependencyRecord.payloadSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(dependencyRecord.payloadSha256)
    ) {
      throw new Error(
        `Invalid package record in prepared inventory: ${JSON.stringify(dependencyRecord)}`,
      );
    }
    const packageRoot = resolve(
      runtimeRoot,
      ...dependencyRecord.path.split("/"),
    );
    const runtimeRelativePath = relative(runtimeRoot, packageRoot);
    if (
      runtimeRelativePath.startsWith(`..${sep}`) ||
      runtimeRelativePath === ".."
    ) {
      throw new Error(
        `Package escapes prepared runtime: ${dependencyRecord.path}`,
      );
    }
    const packageStatus = lstatSync(packageRoot, { throwIfNoEntry: false });
    if (!packageStatus?.isDirectory() || packageStatus.isSymbolicLink()) {
      throw new Error(
        `Dependency inventory path is not a regular directory: ${dependencyRecord.path}`,
      );
    }
    const manifestPath = join(packageRoot, "package.json");
    assertRegularFile(manifestPath, "dependency manifest");
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const pathInstallName = installNameFromRecordPath(
      dependencyRecord.path,
      manifest.name,
    );
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string" ||
      dependencyRecord.installName !== pathInstallName ||
      manifest.name !== dependencyRecord.name ||
      manifest.version !== dependencyRecord.version ||
      sha256(manifestBytes) !== dependencyRecord.packageJsonSha256 ||
      digestPackagePayload(packageRoot) !== dependencyRecord.payloadSha256
    ) {
      throw new Error(
        `Inventory, install path, and manifest identity differ for ${dependencyRecord.path}`,
      );
    }

    const files = collectLicenseFiles(packageRoot).map((path) => {
      assertRegularFile(path, "dependency license evidence");
      const bytes = readFileSync(path);
      if (bytes.length === 0) {
        throw new Error(`Dependency license evidence is empty: ${path}`);
      }
      const digest = retainLicenseText(licenseTexts, bytes);
      return {
        path: relative(packageRoot, path).split(sep).join("/"),
        sha256: digest,
      };
    });

    const packageIdentity = `${manifest.name}@${manifest.version}`;
    const override = REVIEWED_LICENSE_OVERRIDES.get(packageIdentity);
    const sharedLicenseFiles = [];
    if (override) {
      const sharedLicensePath = join(runtimeRoot, override.runtimePath);
      assertRegularFile(sharedLicensePath, "reviewed shared license evidence");
      const bytes = readFileSync(sharedLicensePath);
      if (bytes.length === 0) {
        throw new Error(
          `Reviewed shared license evidence is empty: ${sharedLicensePath}`,
        );
      }
      sharedLicenseFiles.push({
        path: override.runtimePath,
        sha256: retainLicenseText(licenseTexts, bytes),
      });
    }
    const packageJsonLicense = manifestLicense(manifest);
    const isProjectPackage = manifest.name.startsWith(PROJECT_PACKAGE_PREFIX);
    const projectLicense = isProjectPackage ? "MIT" : undefined;
    const licenseDeclared =
      packageJsonLicense ??
      projectLicense ??
      override?.expression ??
      (files.length > 0 ? "NOASSERTION" : undefined);
    if (!licenseDeclared) {
      throw new Error(
        `Dependency has neither a license expression nor bundled evidence: ${packageIdentity}`,
      );
    }
    if (!isProjectPackage && files.length === 0 && !override) {
      throw new Error(
        `Third-party dependency has no retained license terms: ${packageIdentity} (declaration: ${licenseDeclared})`,
      );
    }
    const licensePolicy = classifyLicensePolicy(licenseDeclared);
    if (licensePolicy === "prohibited") {
      throw new Error(
        `Dependency uses a prohibited license: ${packageIdentity} (${licenseDeclared})`,
      );
    }
    const licenseEvidence = projectLicense
      ? "repository-project-license"
      : override
        ? `runtime-shared-license:${override.runtimePath}`
        : "bundled-license-files";

    packages.push({
      path: dependencyRecord.path,
      installName: dependencyRecord.installName,
      name: manifest.name,
      version: manifest.version,
      packageJsonSha256: sha256(manifestBytes),
      payloadSha256: dependencyRecord.payloadSha256,
      licenseDeclared,
      licensePolicy,
      licenseEvidence,
      licenseEvidenceSource: override?.evidenceSource ?? null,
      licenseFiles: files,
      sharedLicenseFiles,
    });
  }

  const projectLicenseBytes = readFileSync(projectLicensePath);
  const licensePolicyCounts = Object.fromEntries(
    Object.keys(LICENSE_POLICY_RANK).map((policy) => [
      policy,
      packages.filter((entry) => entry.licensePolicy === policy).length,
    ]),
  );
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedFrom: RUNTIME_DEPENDENCY_INVENTORY_FILE,
    runtimeSourceLockSha256: sourceLockSha256,
    runtimeDependencyInventorySha256: inventoryMetadata.sha256,
    runtimeDependencyPackagesSha256: inventoryMetadata.packagesSha256,
    project: {
      name: "elizaOS",
      licenseDeclared: "MIT",
      licensePolicy: "allow",
      path: "LICENSE",
      sha256: sha256(projectLicenseBytes),
    },
    packageCount: packages.length,
    licenseTextCount: licenseTexts.size,
    licensePolicyCounts,
    packages,
    licenseTexts: [...licenseTexts.values()].sort((left, right) =>
      left.sha256.localeCompare(right.sha256),
    ),
  };
}

function main() {
  if (process.argv.length !== 3) {
    throw new Error("Usage: generate-license-inventory.mjs <prepared-runtime>");
  }
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../../..");
  const runtimeRoot = resolve(process.argv[2]);
  materializeReviewedLicenseEvidence(runtimeRoot, repositoryRoot);
  const inventory = createInventory(runtimeRoot, repositoryRoot);
  const projectLicense = readFileSync(join(repositoryRoot, "LICENSE"));
  writeFileSync(join(runtimeRoot, "LICENSE"), projectLicense);
  writeFileSync(
    join(runtimeRoot, "THIRD_PARTY_NOTICES.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  process.stdout.write(
    `Recorded ${inventory.packageCount} packages and ${inventory.licenseTextCount} unique license texts\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 distribution builders need the precise legal-evidence
    // failure and a non-zero exit instead of a partially generated inventory.
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
