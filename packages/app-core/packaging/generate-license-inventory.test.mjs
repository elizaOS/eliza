/**
 * Exercises legal-inventory generation against a deterministic prepared tree,
 * including bidirectional closure checks and artifact-local license evidence.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyLicensePolicy,
  collectLicenseFiles,
  createInventory,
  digestPackagePayload,
} from "./generate-license-inventory.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");
const generatorPath = join(testDirectory, "generate-license-inventory.mjs");
const sourceBuffersLicensePath = join(
  testDirectory,
  "licenses/buffers-0.1.1-MIT.txt",
);
const sourceMetamaskLicensePath = join(
  testDirectory,
  "licenses/metamask-eth-json-rpc-provider-1.0.1-ISC.txt",
);
const reviewedLicenseFixtures = [
  {
    name: "@lit-labs/ssr-dom-shim",
    version: "1.6.0",
    expression: "BSD-3-Clause",
    runtimePath: "licenses/lit-ssr-dom-shim-1.6.0-BSD-3-Clause.txt",
    repositoryPath: join(
      testDirectory,
      "licenses/lit-ssr-dom-shim-1.6.0-BSD-3-Clause.txt",
    ),
    stripFinalNewline: true,
  },
  {
    name: "encode-utf8",
    version: "1.0.3",
    expression: "MIT",
    runtimePath: "licenses/encode-utf8-1.0.3-MIT.txt",
    repositoryPath: join(testDirectory, "licenses/encode-utf8-1.0.3-MIT.txt"),
  },
  {
    name: "tr46",
    version: "6.0.0",
    expression: "MIT",
    runtimePath: "licenses/tr46-6.0.0-MIT.txt",
    repositoryPath: join(testDirectory, "licenses/tr46-6.0.0-MIT.txt"),
  },
  {
    name: "uint8arrays",
    version: "3.1.0",
    expression: "MIT",
    runtimePath: "licenses/uint8arrays-3.1.0-MIT.txt",
    repositoryPath: join(testDirectory, "licenses/uint8arrays-3.1.0-MIT.txt"),
  },
];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function writeDependencyInventory(runtimeRoot, packageRoots) {
  const records = packageRoots
    .map((packageRoot) => {
      const manifestBytes = readFileSync(join(packageRoot, "package.json"));
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      const relativePath = runtimePath(runtimeRoot, packageRoot);
      const segments = relativePath.split("/");
      const nodeModulesIndex = segments.lastIndexOf("node_modules");
      const firstNameSegment = segments[nodeModulesIndex + 1];
      const installName =
        nodeModulesIndex < 0
          ? manifest.name
          : firstNameSegment.startsWith("@")
            ? `${firstNameSegment}/${segments[nodeModulesIndex + 2]}`
            : firstNameSegment;
      return {
        path: relativePath,
        installName,
        name: manifest.name,
        version: manifest.version,
        packageJsonSha256: sha256(manifestBytes),
        payloadSha256: digestPackagePayload(packageRoot),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const packagesSha256 = sha256(JSON.stringify(records));
  const inventoryPath = join(runtimeRoot, "elizaos-runtime-dependencies.json");
  writeJson(inventoryPath, {
    schemaVersion: 1,
    generatedFrom: "frozen-bun-install",
    sourceLockSha256: "a".repeat(64),
    packageCount: records.length,
    packagesSha256,
    packages: records,
  });
  const inventorySha256 = sha256(readFileSync(inventoryPath));
  writeJson(join(runtimeRoot, "package.json"), {
    name: "fixture-runtime",
    version: "1.0.0",
    elizaosRuntime: {
      sourceLockSha256: "a".repeat(64),
      dependencyInventory: {
        file: "elizaos-runtime-dependencies.json",
        sha256: inventorySha256,
        packageCount: records.length,
        packagesSha256,
      },
    },
  });
  return { inventorySha256, packagesSha256 };
}

function rewriteDependencyInventory(runtimeRoot, mutate) {
  const inventoryPath = join(runtimeRoot, "elizaos-runtime-dependencies.json");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  mutate(inventory);
  inventory.packagesSha256 = sha256(JSON.stringify(inventory.packages));
  writeJson(inventoryPath, inventory);

  const runtimeManifestPath = join(runtimeRoot, "package.json");
  const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
  runtimeManifest.elizaosRuntime.dependencyInventory.sha256 = sha256(
    readFileSync(inventoryPath),
  );
  runtimeManifest.elizaosRuntime.dependencyInventory.packagesSha256 =
    inventory.packagesSha256;
  writeJson(runtimeManifestPath, runtimeManifest);
}

test("classifies license choices and rejects known prohibited terms", () => {
  assert.equal(classifyLicensePolicy("MIT"), "allow");
  assert.equal(classifyLicensePolicy("MPL-2.0 OR Apache-2.0"), "allow");
  assert.equal(
    classifyLicensePolicy("MIT AND LGPL-3.0-only"),
    "obligation-reviewed",
  );
  assert.equal(
    classifyLicensePolicy("SEE LICENSE IN LICENSE.md"),
    "obligation-reviewed",
  );
  assert.equal(classifyLicensePolicy("AGPL-3.0-or-later"), "prohibited");
  assert.equal(classifyLicensePolicy("BUSL-1.1"), "prohibited");
  assert.equal(
    classifyLicensePolicy("Redis Source Available License v2 (RSALv2)"),
    "prohibited",
  );
  assert.throws(
    () => classifyLicensePolicy("made-up-license"),
    /does not recognize identifier/u,
  );
});

test("verifies the exact runtime closure and retains local license text", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "eliza-license-inventory-"));
  try {
    const workspaceRoot = join(runtimeRoot, "packages/fixture");
    mkdirSync(workspaceRoot, { recursive: true });
    writeJson(join(workspaceRoot, "package.json"), {
      name: "@elizaos/license-fixture",
      version: "1.0.0",
    });
    mkdirSync(join(runtimeRoot, "node_modules/@elizaos"), { recursive: true });
    symlinkSync(
      "../../packages/fixture",
      join(runtimeRoot, "node_modules/@elizaos/license-fixture"),
    );

    const buffersRoot = join(runtimeRoot, "node_modules/buffers");
    mkdirSync(buffersRoot, { recursive: true });
    writeJson(join(buffersRoot, "package.json"), {
      name: "buffers",
      version: "0.1.1",
    });

    const metamaskRoot = join(
      runtimeRoot,
      "node_modules/@metamask/eth-json-rpc-provider",
    );
    mkdirSync(metamaskRoot, { recursive: true });
    writeJson(join(metamaskRoot, "package.json"), {
      name: "@metamask/eth-json-rpc-provider",
      version: "1.0.1",
    });

    const reviewedRoots = reviewedLicenseFixtures.map((fixture) => {
      const packageRoot = join(
        runtimeRoot,
        "node_modules",
        ...fixture.name.split("/"),
      );
      mkdirSync(packageRoot, { recursive: true });
      writeJson(join(packageRoot, "package.json"), {
        name: fixture.name,
        version: fixture.version,
        license: fixture.expression,
      });
      return packageRoot;
    });

    const rpcRoot = join(runtimeRoot, "node_modules/rpc-websockets");
    mkdirSync(rpcRoot, { recursive: true });
    writeJson(join(rpcRoot, "package.json"), {
      name: "rpc-websockets",
      version: "9.3.9",
      license: "LGPL-3.0-only",
    });

    const jsquashRoot = join(runtimeRoot, "node_modules/@jsquash/webp");
    mkdirSync(join(jsquashRoot, "codec"), { recursive: true });
    writeJson(join(jsquashRoot, "package.json"), {
      name: "@jsquash/webp",
      version: "1.5.0",
      license: "Apache-2.0",
    });
    writeFileSync(join(jsquashRoot, "LICENSE"), "Apache fixture terms\n");
    writeFileSync(
      join(jsquashRoot, "codec/LICENSE.codec.md"),
      "libwebp BSD-3-Clause fixture terms\n",
    );

    const aliasedRoot = join(runtimeRoot, "node_modules/cache-alias");
    mkdirSync(aliasedRoot, { recursive: true });
    writeJson(join(aliasedRoot, "package.json"), {
      name: "real-cache",
      version: "3.2.1",
      license: "MIT",
    });
    writeFileSync(
      join(aliasedRoot, "LICENSE"),
      readFileSync(join(repositoryRoot, "LICENSE")),
    );

    const orchestratorRoot = join(
      runtimeRoot,
      "node_modules/@elizaos/plugin-agent-orchestrator",
    );
    mkdirSync(orchestratorRoot, { recursive: true });
    writeJson(join(orchestratorRoot, "package.json"), {
      name: "@elizaos/plugin-agent-orchestrator",
      version: "2.0.3-beta.7",
    });

    const packageRoots = [
      aliasedRoot,
      buffersRoot,
      metamaskRoot,
      ...reviewedRoots,
      rpcRoot,
      jsquashRoot,
      orchestratorRoot,
      workspaceRoot,
    ];
    const metadata = writeDependencyInventory(runtimeRoot, packageRoots);
    const generated = spawnSync(
      process.execPath,
      [generatorPath, runtimeRoot],
      {
        encoding: "utf8",
      },
    );
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);

    const inventory = JSON.parse(
      readFileSync(join(runtimeRoot, "THIRD_PARTY_NOTICES.json"), "utf8"),
    );
    assert.equal(inventory.generatedFrom, "elizaos-runtime-dependencies.json");
    assert.equal(
      inventory.runtimeDependencyInventorySha256,
      metadata.inventorySha256,
    );
    assert.equal(
      inventory.runtimeDependencyPackagesSha256,
      metadata.packagesSha256,
    );
    assert.equal(inventory.packages.length, packageRoots.length);
    assert.deepEqual(inventory.licensePolicyCounts, {
      allow: packageRoots.length - 1,
      "obligation-reviewed": 1,
      prohibited: 0,
    });
    assert.ok(
      inventory.packages.some(
        ({ installName, name, version }) =>
          installName === "cache-alias" &&
          name === "real-cache" &&
          version === "3.2.1",
      ),
    );

    const buffersLicenseBytes = readFileSync(sourceBuffersLicensePath);
    const buffersLicenseSha256 = sha256(buffersLicenseBytes);
    const buffersEntry = inventory.packages.find(
      (entry) => entry.name === "buffers",
    );
    assert.equal(buffersEntry.licenseDeclared, "MIT");
    assert.equal(
      buffersEntry.licenseEvidence,
      "runtime-shared-license:licenses/buffers-0.1.1-MIT.txt",
    );
    assert.deepEqual(buffersEntry.sharedLicenseFiles, [
      {
        path: "licenses/buffers-0.1.1-MIT.txt",
        sha256: buffersLicenseSha256,
      },
    ]);
    assert.deepEqual(
      readFileSync(join(runtimeRoot, "licenses/buffers-0.1.1-MIT.txt")),
      buffersLicenseBytes,
    );
    assert.match(
      inventory.licenseTexts.find(
        (entry) => entry.sha256 === buffersLicenseSha256,
      ).content,
      /2015 James Halliday/u,
    );

    const metamaskLicenseBytes = readFileSync(sourceMetamaskLicensePath);
    const metamaskLicenseSha256 = sha256(metamaskLicenseBytes);
    const metamaskEntry = inventory.packages.find(
      (entry) => entry.name === "@metamask/eth-json-rpc-provider",
    );
    assert.equal(metamaskEntry.licenseDeclared, "ISC");
    assert.equal(
      metamaskEntry.licenseEvidence,
      "runtime-shared-license:licenses/metamask-eth-json-rpc-provider-1.0.1-ISC.txt",
    );
    assert.deepEqual(metamaskEntry.sharedLicenseFiles, [
      {
        path: "licenses/metamask-eth-json-rpc-provider-1.0.1-ISC.txt",
        sha256: metamaskLicenseSha256,
      },
    ]);
    assert.deepEqual(
      readFileSync(
        join(
          runtimeRoot,
          "licenses/metamask-eth-json-rpc-provider-1.0.1-ISC.txt",
        ),
      ),
      metamaskLicenseBytes,
    );

    for (const fixture of reviewedLicenseFixtures) {
      const entry = inventory.packages.find(
        ({ name, version }) =>
          name === fixture.name && version === fixture.version,
      );
      const evidenceBytes = readFileSync(fixture.repositoryPath);
      const runtimeEvidenceBytes = fixture.stripFinalNewline
        ? evidenceBytes.subarray(0, -1)
        : evidenceBytes;
      assert.equal(entry.licenseDeclared, fixture.expression);
      assert.equal(entry.licensePolicy, "allow");
      assert.equal(
        entry.licenseEvidence,
        `runtime-shared-license:${fixture.runtimePath}`,
      );
      assert.deepEqual(entry.sharedLicenseFiles, [
        { path: fixture.runtimePath, sha256: sha256(runtimeEvidenceBytes) },
      ]);
      assert.deepEqual(
        readFileSync(join(runtimeRoot, fixture.runtimePath)),
        runtimeEvidenceBytes,
      );
    }

    const rpcEntry = inventory.packages.find(
      (entry) => entry.name === "rpc-websockets",
    );
    assert.equal(rpcEntry.licensePolicy, "obligation-reviewed");
    assert.equal(
      rpcEntry.licenseEvidence,
      "runtime-shared-license:licenses/rpc-websockets-9.3.9-LGPL-3.0-only-COMPLETE.txt",
    );
    const rpcEvidence = readFileSync(
      join(
        runtimeRoot,
        "licenses/rpc-websockets-9.3.9-LGPL-3.0-only-COMPLETE.txt",
      ),
      "utf8",
    );
    assert.match(rpcEvidence, /SOURCE AND RELINKING INFORMATION/u);
    assert.match(rpcEvidence, /GNU LESSER GENERAL PUBLIC LICENSE/u);
    assert.match(rpcEvidence, /GNU GENERAL PUBLIC LICENSE/u);
    assert.match(rpcEvidence, /af8980776b55c2320b790556f775266fd5afc3ce/u);

    const jsquashEntry = inventory.packages.find(
      (entry) => entry.name === "@jsquash/webp",
    );
    assert.deepEqual(
      jsquashEntry.licenseFiles.map((entry) => entry.path),
      ["codec/LICENSE.codec.md", "LICENSE"],
    );

    const injectedRoot = join(runtimeRoot, "node_modules/injected");
    mkdirSync(injectedRoot);
    writeJson(join(injectedRoot, "package.json"), {
      name: "injected",
      version: "1.0.0",
      license: "MIT",
    });
    assert.throws(
      () => createInventory(runtimeRoot, repositoryRoot),
      /dependency set differs/u,
    );
    rmSync(injectedRoot, { recursive: true });

    rewriteDependencyInventory(runtimeRoot, (dependencyInventory) => {
      dependencyInventory.packages[0].installName = "wrong-name";
    });
    assert.throws(
      () => createInventory(runtimeRoot, repositoryRoot),
      /Inventory, install path, and manifest identity differ/u,
    );

    symlinkSync("package.json", join(workspaceRoot, "LICENSE-link"));
    assert.throws(
      () => collectLicenseFiles(workspaceRoot),
      /License evidence must not be a symlink/u,
    );
    rmSync(join(workspaceRoot, "LICENSE-link"));

    const manifestOnlyRoot = join(runtimeRoot, "node_modules/manifest-only");
    mkdirSync(manifestOnlyRoot);
    writeJson(join(manifestOnlyRoot, "package.json"), {
      name: "manifest-only",
      version: "1.0.0",
      license: "MIT",
    });
    writeDependencyInventory(runtimeRoot, [...packageRoots, manifestOnlyRoot]);
    assert.throws(
      () => createInventory(runtimeRoot, repositoryRoot),
      /Third-party dependency has no retained license terms: manifest-only@1\.0\.0/u,
    );
    rmSync(manifestOnlyRoot, { recursive: true });

    const prohibitedRoot = join(runtimeRoot, "node_modules/prohibited-license");
    mkdirSync(prohibitedRoot);
    writeJson(join(prohibitedRoot, "package.json"), {
      name: "prohibited-license",
      version: "1.0.0",
      license: "AGPL-3.0-or-later",
    });
    writeFileSync(join(prohibitedRoot, "LICENSE"), "AGPL fixture terms\n");
    writeDependencyInventory(runtimeRoot, [...packageRoots, prohibitedRoot]);
    assert.throws(
      () => createInventory(runtimeRoot, repositoryRoot),
      /Dependency uses a prohibited license: prohibited-license@1\.0\.0/u,
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
