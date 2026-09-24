/** Guards the standalone repository's OS release writer and recovery boundaries. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
  uses?: string;
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowsDirectory = join(repositoryRoot, ".github", "workflows");
const automaticManifestWorkflow = "elizaos-os-full-release.yml";
const recoveryWorkflow = "update-os-release-manifest.yml";
const ripgrepProvisioner = "scripts/provision-ripgrep.sh";
const actionlintProvisioner = "scripts/provision-actionlint.sh";
const zigProvisioner = "scripts/provision-zig-linux-x64.sh";

function workflowPath(name: string): string {
  return join(workflowsDirectory, name);
}

function parseWorkflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(workflowPath(name), "utf8")) as Workflow;
}

function workflowNames(): string[] {
  return readdirSync(workflowsDirectory)
    .filter((entry) => /\.ya?ml$/.test(entry))
    .sort();
}

function localReusableCalls(workflow: Workflow): string[] {
  return Object.values(workflow.jobs ?? {})
    .map((job) => job.uses)
    .filter((value): value is string =>
      Boolean(value?.startsWith("./.github/workflows/")),
    )
    .map((value) => value.slice("./.github/workflows/".length));
}

function namedStep(workflow: Workflow, name: string): WorkflowStep {
  const step = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

function namedJobStep(
  workflow: Workflow,
  jobName: string,
  name: string,
): WorkflowStep {
  const step = workflow.jobs?.[jobName]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

describe("OS release workflow authority", () => {
  test("optional Hetzner runners are opt-in and hosted runners are the default", () => {
    const optInExpression =
      "vars.HETZNER_FLEET_ONLINE == 'true' && '[\"self-hosted\",\"hetzner-robot\"]' || '[\"ubuntu-24.04\"]'";
    const hetznerWorkflows = workflowNames().filter((name) =>
      readFileSync(workflowPath(name), "utf8").includes("HETZNER_FLEET_ONLINE"),
    );

    expect(hetznerWorkflows.length).toBeGreaterThan(0);
    for (const name of hetznerWorkflows) {
      const source = readFileSync(workflowPath(name), "utf8");
      expect(source).toContain(optInExpression);
      expect(source).not.toContain("HETZNER_FLEET_ONLINE == 'false'");
    }
  });

  test("standalone verification owns its Bun and Eliza source inputs", () => {
    const workflow = parseWorkflow("ci.yml");
    const packageMetadata = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { engines?: { node?: string }; packageManager?: string };
    const verifyNodeSetup = namedJobStep(workflow, "verify", "Setup Node 24");
    const verifyBunSetup = namedJobStep(
      workflow,
      "verify",
      "Setup Bun from packageManager",
    );
    const actionlintSetup = namedJobStep(
      workflow,
      "verify",
      "Provision pinned actionlint",
    );
    const actionlintCache = namedJobStep(
      workflow,
      "verify",
      "Restore actionlint archive cache",
    );
    const actionlintRun = namedJobStep(
      workflow,
      "verify",
      "Lint GitHub Actions workflows",
    );
    const sourceCheckout = namedJobStep(
      workflow,
      "linux-static-smoke",
      "Checkout application source",
    );
    const linuxBunSetup = namedJobStep(
      workflow,
      "linux-static-smoke",
      "Setup Bun from packageManager",
    );
    const linuxNodeSetup = namedJobStep(
      workflow,
      "linux-static-smoke",
      "Setup Node 24",
    );
    const ripgrepSetup = namedJobStep(
      workflow,
      "linux-static-smoke",
      "Provision ripgrep for Linux static smoke",
    );
    const linuxJob = workflow.jobs?.["linux-static-smoke"];
    const linuxSteps = linuxJob?.steps ?? [];

    expect(packageMetadata.packageManager).toBe("bun@1.3.14");
    expect(packageMetadata.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
    expect(packageMetadata.engines?.node).toBe(">=24.0.0");
    expect(verifyNodeSetup.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(linuxNodeSetup.uses).toBe(verifyNodeSetup.uses);
    expect(verifyNodeSetup.with?.["node-version"]).toBe("24");
    expect(linuxNodeSetup.with?.["node-version"]).toBe("24");
    expect(verifyBunSetup.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/);
    expect(linuxBunSetup.uses).toBe(verifyBunSetup.uses);
    expect(verifyBunSetup.with?.["bun-version-file"]).toBe("package.json");
    expect(actionlintCache.with?.path).toBe("~/.cache/elizaos/actionlint");
    expect(actionlintCache.with?.key).toContain("actionlint-v1.7.12-");
    expect(actionlintSetup.run).toBe(actionlintProvisioner);
    expect(actionlintRun.run).toBe("actionlint");
    expect(linuxBunSetup.with?.["bun-version-file"]).toBe("package.json");
    expect(sourceCheckout.with).toMatchObject({
      repository: "${{ steps.eliza-source.outputs.repository }}",
      ref: "${{ steps.eliza-source.outputs.commit }}",
      path: ".eliza-source",
      submodules: "recursive",
    });
    expect(linuxJob?.env?.ELIZAOS_ELIZA_ROOT).toMatch(
      /github\.workspace.*\.eliza-source/,
    );
    expect(ripgrepSetup.shell).toBe("bash");
    expect(ripgrepSetup.run).toBe(ripgrepProvisioner);
    const ripgrepIndex = linuxSteps.indexOf(ripgrepSetup);
    const verifyLinuxIndex = linuxSteps.findIndex(
      (step) => step.run === "bun run verify:linux",
    );
    expect(ripgrepIndex).toBeGreaterThan(-1);
    expect(verifyLinuxIndex).toBeGreaterThan(ripgrepIndex);

    const cuttlefish = parseWorkflow("elizaos-cuttlefish.yml");
    const cuttlefishBunSetup = Object.values(cuttlefish.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.uses === verifyBunSetup.uses);
    expect(cuttlefishBunSetup?.with?.["bun-version-file"]).toBe(
      ".eliza-source/package.json",
    );
  });

  test("Bun download caches reuse immutable package archives without weakening compiled-output keys", () => {
    const bunCacheSteps: Array<{ name: string; step: WorkflowStep }> = [];

    for (const name of workflowNames()) {
      const workflow = parseWorkflow(name);
      for (const step of Object.values(workflow.jobs ?? {}).flatMap(
        (job) => job.steps ?? [],
      )) {
        if (step.with?.path === "~/.bun/install/cache") {
          bunCacheSteps.push({ name, step });
        }
      }
    }

    expect(bunCacheSteps.length).toBeGreaterThan(0);
    for (const { name, step } of bunCacheSteps) {
      const key = step.with?.key ?? "";
      const restoreKeys = step.with?.["restore-keys"] ?? "";
      expect(key, name).toContain("${{ runner.os }}-${{ runner.arch }}-");
      expect(key, name).not.toContain("steps.eliza-source.outputs.commit");
      expect(restoreKeys, name).toBe(
        key.slice(0, key.indexOf("${{ hashFiles(")),
      );
    }

    const riscv = namedJobStep(
      parseWorkflow("riscv64-smoke.yml"),
      "smoke",
      "Restore Bun download cache",
    );
    expect(riscv.with?.key).toContain(
      "hashFiles('bun.lock', '.eliza-source/bun.lock')",
    );

    const riscvSource = readFileSync(workflowPath("riscv64-smoke.yml"), "utf8");
    expect(riscvSource).toContain("key: riscv64-out-");
    expect(riscvSource).not.toContain("restore-keys: riscv64-out-");
  });

  test("RISC-V cold-build failures retain their compiler diagnostics", () => {
    const source = readFileSync(workflowPath("riscv64-smoke.yml"), "utf8");

    expect(source).toContain("name: Print failed RISC-V build diagnostics");
    expect(source).toContain(`if: \${{ failure() }}`);
    expect(source).toContain("tail -n 250");
    expect(source).toContain("name: riscv64-build-diagnostics");
    expect(source).toContain(
      ".eliza-source/packages/native/plugins/*/build/**/*.log",
    );
    expect(source).toContain("include-hidden-files: true");
  });

  test("desktop distributors share the exact Electrobun CLI and runtime cache", () => {
    const workflowNames = [
      "release-elizaos-setup.yml",
      "release-usb-installer.yml",
    ];
    const caches = workflowNames.map((name) =>
      namedJobStep(
        parseWorkflow(name),
        "build",
        "Restore checksum-pinned Electrobun release assets",
      ),
    );

    for (const cache of caches) {
      expect(cache.with?.path).toBe("~/.cache/elizaos/electrobun/v1.18.1");
      expect(cache.with?.["restore-keys"]).toBeUndefined();
    }
    expect(caches[0]?.with?.key).toBe(caches[1]?.with?.key);
    expect(caches[0]?.with?.key).toBe(
      "electrobun-assets-v1.18.1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/provision-electrobun-runtime.sh') }}",
    );

    for (const name of workflowNames) {
      const provision = namedJobStep(
        parseWorkflow(name),
        "build",
        "Verify and provision Electrobun runtime",
      );
      expect(provision.run).toBe(
        "scripts/provision-electrobun-runtime.sh",
      );
    }

    const provisioner = readFileSync(
      join(
        repositoryRoot,
        "scripts/provision-electrobun-runtime.sh",
      ),
      "utf8",
    );
    expect(provisioner).toContain('version="1.18.1"');
    expect(provisioner.match(/[a-f0-9]{64}/g)?.length).toBe(15);
    expect(provisioner).toContain("verify_sha256");
  });

  test("browser release lanes share an exact Playwright Chromium cache", () => {
    for (const name of [
      "elizaos-os-release.yml",
      "publish-os-homepage.yml",
      "release-usb-installer.yml",
    ]) {
      const cache = namedJobStep(
        parseWorkflow(name),
        name === "release-usb-installer.yml"
          ? "build"
          : name === "publish-os-homepage.yml"
            ? "publish"
            : "validate-os-release",
        "Restore Playwright Chromium cache",
      );
      expect(cache.with?.path, name).toBe("~/.cache/ms-playwright");
      expect(cache.with?.key, name).toBe(
        "playwright-chromium-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('bun.lock') }}",
      );
      expect(cache.with?.["restore-keys"], name).toBeUndefined();
    }
  });

  test("Debian package publication fails when lintian fails", () => {
    const workflow = readFileSync(
      workflowPath("build-debian-package.yml"),
      "utf8",
    );
    expect(workflow).toContain("if grep -q '^E:'");
    expect(workflow).toContain('exit "$status"');
    expect(workflow).not.toContain("annotations only; not failing build");
  });

  test("every checked-in AOSP brand resolves to an OS-owned vendor tree", () => {
    const brandDirectory = join(repositoryRoot, "scripts", "distro-android");
    const configs = readdirSync(brandDirectory).filter((entry) =>
      /^brand\..+\.json$/.test(entry),
    );

    expect(configs.length).toBeGreaterThan(0);
    for (const configName of configs) {
      const config = JSON.parse(
        readFileSync(join(brandDirectory, configName), "utf8"),
      ) as { vendorDir?: string };
      expect(config.vendorDir).toMatch(/^android\/vendor\//);
      expect(existsSync(join(repositoryRoot, config.vendorDir as string))).toBe(
        true,
      );
    }
  });

  test("release validation provisions ripgrep before Linux metadata checks", () => {
    const workflow = parseWorkflow("elizaos-os-release.yml");
    const source = readFileSync(workflowPath("elizaos-os-release.yml"), "utf8");
    const steps = workflow.jobs?.["validate-os-release"]?.steps ?? [];
    const provision = namedJobStep(
      workflow,
      "validate-os-release",
      "Provision ripgrep for Linux metadata validation",
    );
    const validation = namedJobStep(
      workflow,
      "validate-os-release",
      "Validate Linux live USB metadata",
    );

    expect(provision.run).toBe(ripgrepProvisioner);
    expect(steps.indexOf(provision)).toBeGreaterThan(-1);
    expect(steps.indexOf(validation)).toBeGreaterThan(steps.indexOf(provision));
    expect(validation.run).toContain("elizaos/scripts/mkosi-lint.sh");
    expect(validation.run).not.toContain("static-smoke.sh");
    expect(source).toContain("assert-canonical-linux-release.mjs");
    expect(source).toContain(
      "for script in scripts/*.mjs scripts/*.mjs; do",
    );
    expect(source).toContain(
      "bun run --cwd usb-installer lint:check",
    );
    expect(source).not.toContain(
      "bun run --cwd usb-installer lint\n",
    );
    const usbValidation = namedJobStep(
      workflow,
      "validate-os-release",
      "Validate USB installer",
    );
    // The root has no Playwright dependency. bunx there can download a newer
    // CLI/browser revision than the locked workspace test runner requires.
    const browserInstall =
      "bun usb-installer/node_modules/@playwright/test/cli.js install --with-deps chromium";
    expect(usbValidation.run).toContain(browserInstall);
    expect(usbValidation.run).not.toContain("bunx playwright");
    expect(usbValidation.run.indexOf(browserInstall)).toBeLessThan(
      usbValidation.run.indexOf(
        "bun run --cwd usb-installer test:e2e",
      ),
    );
    expect(source).toContain("bun run --cwd setup test");
    expect(source).toContain(
      "cd homepage && bunx playwright install --with-deps chromium",
    );
  });

  test("Linux CI validates both legacy smoke and canonical mkosi contracts", () => {
    const source = readFileSync(workflowPath("ci.yml"), "utf8");
    expect(source).toContain("bun run verify:linux");
    expect(source).toContain(
      "bash linux/elizaos/scripts/mkosi-lint.sh",
    );
    expect(source).toContain("test_mkosi_qualification.py");
    expect(source).toContain("test_verify_desktop_artifact.py");
    expect(source).toContain("linux-usb-virtual-block:");
    expect(source).toContain(
      "bun run --cwd usb-installer test:linux-virtual-usb",
    );
    expect(source).toContain(
      "Exercise signed raw.zst write and expanded-byte readback",
    );
  });

  test("one checked provisioner owns the ripgrep release", () => {
    const provisionerPath = join(repositoryRoot, ripgrepProvisioner);
    const source = readFileSync(provisionerPath, "utf8");

    expect(statSync(provisionerPath).mode & 0o111).not.toBe(0);
    expect(source).toContain("version=15.1.0");
    expect(source).toContain("X64) target=x86_64-unknown-linux-musl");
    expect(source).toContain("ARM64) target=aarch64-unknown-linux-gnu");
    expect(source).toContain(`sha256sum --check "\${archive}.sha256"`);
    expect(source).toContain(`echo "\${bin_dir}" >> "\${GITHUB_PATH}"`);
  });

  test("one checked provisioner owns the actionlint release", () => {
    const provisionerPath = join(repositoryRoot, actionlintProvisioner);
    const source = readFileSync(provisionerPath, "utf8");

    expect(statSync(provisionerPath).mode & 0o111).not.toBe(0);
    expect(source).toContain("version=1.7.12");
    expect(source).toContain("target=linux_amd64");
    expect(source).toContain("target=linux_arm64");
    expect(source).toContain("target=darwin_arm64");
    expect(source).toContain(`sha256sum "$path"`);
    expect(source).toContain('shasum -a 256 "$path"');
    expect(source).toContain(`echo "$bin_dir" >> "$GITHUB_PATH"`);
  });

  test("native CI reuses only checksum-verified, exact-input toolchains and outputs", () => {
    const provisionerPath = join(repositoryRoot, zigProvisioner);
    const provisioner = readFileSync(provisionerPath, "utf8");
    const riscv = readFileSync(workflowPath("riscv64-smoke.yml"), "utf8");
    const cuttlefish = readFileSync(
      workflowPath("elizaos-cuttlefish.yml"),
      "utf8",
    );

    expect(statSync(provisionerPath).mode & 0o111).not.toBe(0);
    expect(provisioner).toContain("0.13.0)");
    expect(provisioner).toContain("0.14.0)");
    expect(provisioner).toContain("0.14.1)");
    expect(provisioner).toContain(
      "24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c",
    );
    expect(provisioner).toContain(
      "d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea",
    );
    expect(provisioner).toContain(
      "473ec26806133cf4d1918caf1a410f8403a13d979726a9045b421b685031a982",
    );
    expect(provisioner).toContain("sha256sum --check --status");
    expect(provisioner).toContain(
      "refusing a symlinked Zig archive cache entry",
    );
    expect(riscv).toContain(`${zigProvisioner} "$ZIG_VERSION"`);
    expect(riscv).toContain('ZIG_VERSION: "0.13.0"');
    expect(riscv).toContain("zig-archive-${{ runner.os }}-${{ runner.arch }}-");
    expect(cuttlefish).toContain(`${zigProvisioner} "$ZIG_VERSION"`);
    expect(cuttlefish).toContain("Compute native inference source fingerprint");
    expect(cuttlefish).toContain(
      "git -C .eliza-source submodule status --recursive",
    );
    expect(cuttlefish).toContain('ANDROID_NDK_VERSION: "29.0.13113456"');
    expect(cuttlefish).toContain('"$GITHUB_WORKFLOW_SHA"');
    expect(cuttlefish).toContain("key: cuttlefish-native-");
    expect(cuttlefish).not.toContain("restore-keys: cuttlefish-native-");
  });

  test("all local reusable workflow calls resolve", () => {
    for (const callerName of workflowNames()) {
      for (const calleeName of localReusableCalls(parseWorkflow(callerName))) {
        expect(existsSync(workflowPath(calleeName))).toBe(true);
        expect(parseWorkflow(calleeName).on?.workflow_call).toBeDefined();
      }
    }
  });

  test("release manifest writers are explicit manual operations", () => {
    const writers = workflowNames().filter((name) => {
      const source = readFileSync(workflowPath(name), "utf8");
      return /scripts\/(?:update-release-manifest|generate-release-checksums)\.mjs/.test(
        source,
      );
    });
    expect(writers).toContain(automaticManifestWorkflow);
    expect(writers).toContain(recoveryWorkflow);
    expect(
      Object.keys(parseWorkflow(automaticManifestWorkflow).on ?? {}),
    ).toEqual(["workflow_dispatch"]);
    expect(Object.keys(parseWorkflow(recoveryWorkflow).on ?? {})).toEqual([
      "workflow_dispatch",
    ]);
  });

  test("full release is a manual single-writer fail-closed coordinator", () => {
    const workflow = parseWorkflow(automaticManifestWorkflow);
    const source = readFileSync(
      workflowPath(automaticManifestWorkflow),
      "utf8",
    );

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({
      contents: "write",
      pages: "write",
      "id-token": "write",
      attestations: "write",
    });
    expect(source).toContain("environment: release");
    expect(source).toContain(
      "release coordinator source $" +
        "{source_sha} is not contained in origin/develop",
    );
    expect(source).toContain("git merge-base --is-ancestor");
    expect(source).toContain("release coordinator checkout is not clean");
    expect(source).toContain("assemble-release-bundle.mjs");
    expect(source).toContain("assert-canonical-linux-release.mjs");
    expect(source).toContain("uses: ./.github/workflows/build-linux-mkosi.yml");
    expect(source).not.toContain(
      "uses: ./.github/workflows/build-vm-image.yml",
    );
    expect(source).not.toContain(
      "uses: ./.github/workflows/build-linux-iso.yml",
    );
    expect(source).toContain(
      '--source-sha "${{ needs.prepare.outputs.source-sha }}"',
    );
    expect(source).toContain(
      '--available-date "${{ needs.prepare.outputs.release-date }}"',
    );
    expect(source).not.toContain('--evidence "$evidence"');
    expect(source).not.toContain("evidence=seabios-boot");
    expect(source).toContain("name: elizaos-release-bundle");
    expect(source).toContain("name: Rehearse signed APT publication");
    expect(source).toContain("dry_run: true");
    expect(source).toContain("name: Stage the verified GitHub Release draft");
    expect(source).toContain("draft: true");
    expect(source).toContain(
      "if: inputs.publish == true && needs.publish-apt.result == 'success'",
    );
    expect(source).toContain('gh release edit "$RELEASE_TAG" --draft=false');
    expect(source).toContain("--require-publishable-checksums");
    expect(source).not.toContain("beta-2026-05-16");
    expect(source).not.toContain("types: [created]");
  });

  test("canonical mkosi producer signs complete assets but cannot invent downstream qualification", () => {
    const workflowName = "build-linux-mkosi.yml";
    const source = readFileSync(workflowPath(workflowName), "utf8");
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "release/v0.1.0-beta.1/manifest.json"),
        "utf8",
      ),
    ) as {
      artifacts: Array<{
        kind: string;
        source: { artifact: string; pattern: string };
      }>;
    };

    expect(existsSync(workflowPath("build-vm-image.yml"))).toBe(false);
    expect(source).toContain("architecture: x86_64");
    expect(source).toContain("architecture: arm64");
    expect(source).toContain("architecture: riscv64");
    expect(source).toContain("repository: elizaOS/eliza");
    expect(source).toContain("verify-desktop-artifact.py");
    expect(source).toContain("[A-Za-z0-9._-]*\\.(?:pem|key|der)");
    expect(source).toContain('snapshot_id="${SNAPSHOT_URL%/}"');
    expect(source).toContain(
      "mkosi-packages/${snapshot_id}/${{ matrix.architecture }}",
    );
    expect(source).not.toContain(
      "mkosi-packages/${{ inputs.source_date_epoch }}",
    );
    expect(source).toContain('flock --exclusive "$cache/.build.lock"');
    expect(source).toContain('--package-cache-dir "$cache"');
    expect(source).toContain("name: Remove privileged build workspace");
    expect(source).toContain("name: Remove signing workspace");
    expect(source).toContain("mkosi-persistence-qualify.py");
    expect(source).toContain(
      "name: QEMU legacy-BIOS boot exact x86_64 disk as removable USB",
    );
    expect(source).toContain("legacy-bios: /usr/share/qemu/bios-256k.bin");
    expect(source).toContain("--legacy-bios-evidence");
    expect(source).toContain(
      '"$WORK_ROOT/unsigned/qemu-legacy-bios-x86_64.json"',
    );
    expect(source).toContain(
      '"$WORK_ROOT/unsigned/persistence-boot-2-${architecture}.log"',
    );
    expect(source).toContain("Stage one flat bounded pre-signing artifact");
    expect(source).toContain("path: ${{ env.WORK_ROOT }}/upload/*");
    expect(source).toContain("verify-mkosi-promotion-evidence.mjs");
    expect(source).toContain("sign-image-release.mjs");
    expect(source).toContain("verify-image-release.mjs");
    expect(source).toContain("--require-private-root");
    expect(source).toContain('--publish-root "$WORK_ROOT/publish"');
    expect(source).toContain("name: Seal private offline signing root");
    expect(source).toContain('chmod 0700 -- "$WORK_ROOT/unsigned"');
    expect(source).toContain(
      'test "$(stat -c \'%a\' -- "$WORK_ROOT/unsigned")" = 700',
    );
    expect(source).not.toContain('mkdir -p "$WORK_ROOT/publish/metadata"');
    expect(source).not.toMatch(
      /cp --[\s\\]*\n[\s\S]{0,300}\$WORK_ROOT\/unsigned\/elizaos-\$\{\{ inputs\.version \}\}-images\.json/,
    );
    expect(source).not.toMatch(
      /cp --[\s\S]{0,300}\$WORK_ROOT\/unsigned\/elizaos-\$\{\{ inputs\.version \}\}-\$\{architecture\}\.raw\.zst(?:"|\\)/,
    );
    expect(source).toContain("ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256");
    expect(source).toContain(
      "ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S",
    );
    expect(source).toContain(
      'boot_evidence="mkosi-release-build,qemu-uefi-usb,persistent-reboot,usb-expanded-readback,slsa-provenance"',
    );
    expect(source).toContain("qemu-legacy-bios-usb");
    expect(source).not.toMatch(
      /--evidence[^\n]*(?:whole-disk-install|alongside-install|desktop-acceptance|hardware-qualification)/,
    );
    for (const artifact of manifest.artifacts.filter((candidate) =>
      ["raw-image", "signature", "sbom", "release-metadata"].includes(
        candidate.kind,
      ),
    )) {
      expect(source).toContain(artifact.source.artifact);
    }
  });

  test("desktop distributors upload stable payloads rather than build trees", () => {
    for (const name of [
      "release-elizaos-setup.yml",
      "release-usb-installer.yml",
    ]) {
      const source = readFileSync(workflowPath(name), "utf8");
      expect(source).toContain("ubuntu-24.04");
      expect(source).toContain("macos-15");
      expect(source).toContain("windows-2025");
      expect(source).not.toMatch(/(?:ubuntu|macos|windows)-latest/);
      expect(source).toContain("Require one release payload");
      expect(source).toContain("/artifacts/${{ matrix.payload-pattern }}");
      expect(source).not.toContain("path: setup/build/");
      expect(source).not.toContain("path: usb-installer/build/");
    }
  });

  test("desktop producer release matrices exactly match candidate artifact identities", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "release/v0.1.0-beta.1/manifest.json"),
        "utf8",
      ),
    ) as {
      artifacts: Array<{
        id: string;
        kind: string;
        source: { artifact: string; pattern: string };
      }>;
    };
    for (const [workflowName, kind] of [
      ["release-elizaos-setup.yml", "setup-installer"],
    ]) {
      const workflow = parseWorkflow(workflowName);
      const job = workflow.jobs?.build as WorkflowJob & {
        strategy?: {
          matrix?: {
            include?: Array<{
              artifact: string;
              "payload-pattern": string;
              "release-id": string;
            }>;
          };
        };
      };
      const produced = (job.strategy?.matrix?.include ?? [])
        .map((entry) => ({
          artifact: entry.artifact,
          id: entry["release-id"],
          pattern: entry["payload-pattern"],
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const declared = manifest.artifacts
        .filter((artifact) => artifact.kind === kind)
        .map((artifact) => ({
          artifact: artifact.source.artifact,
          id: artifact.id,
          pattern: artifact.source.pattern,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));

      expect(produced).toEqual(declared);
      expect(readFileSync(workflowPath(workflowName), "utf8")).toContain(
        "create-release-evidence.mjs",
      );
    }

    const usbSource = readFileSync(
      workflowPath("release-usb-installer.yml"),
      "utf8",
    );
    const usbDeclared = manifest.artifacts.filter(
      (artifact) => artifact.kind === "usb-installer",
    );
    expect(usbDeclared).toEqual([
      expect.objectContaining({
        id: "usb-installer-linux-x64",
        source: {
          artifact: "elizaos-usb-installer-linux",
          pattern: "*.tar.gz",
        },
      }),
    ]);
    expect(usbSource).toContain("linux_release_only:");
    expect(usbSource).toContain(
      'inputs.linux_release_only && \'[{"os":"ubuntu-24.04"',
    );
    expect(usbSource).toContain('"release-id":"usb-installer-linux-x64"');
    expect(usbSource).toContain("create-release-evidence.mjs");

    const coordinator = readFileSync(
      workflowPath("elizaos-os-full-release.yml"),
      "utf8",
    );
    expect(coordinator).toContain("linux_release_only: true");
    expect(coordinator).toContain(
      'require_file _verify/elizaos-usb-installer-linux "*.tar.gz"',
    );
    expect(coordinator).not.toContain(
      'require_file "_verify/elizaos-usb-installer-${platform}"',
    );
  });

  test("release producers reject ambiguous outputs instead of selecting first or last", () => {
    for (const workflowName of [
      "build-debian-package.yml",
      "build-linux-mkosi.yml",
    ]) {
      const source = readFileSync(workflowPath(workflowName), "utf8");
      expect(source).not.toMatch(/find[^\n]*(?:head|tail)\s+-?n?\s*1/);
      expect(source).toContain("expected exactly one");
    }
    expect(
      readFileSync(workflowPath("build-debian-package.yml"), "utf8"),
    ).toContain("if-no-files-found: error");
  });

  test("Debian packages consume authenticated native artifacts and declare exact architectures", () => {
    const source = readFileSync(
      workflowPath("build-debian-package.yml"),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(
        join(repositoryRoot, "release/v0.1.0-beta.1/manifest.json"),
        "utf8",
      ),
    ) as {
      artifacts: Array<{
        id: string;
        kind: string;
        target: { architecture: string };
      }>;
    };
    const packages = manifest.artifacts.filter(
      (artifact) => artifact.kind === "package",
    );
    const control = readFileSync(
      join(repositoryRoot, "linux/packaging/debian/control"),
      "utf8",
    );
    const rules = readFileSync(
      join(repositoryRoot, "linux/packaging/debian/rules"),
      "utf8",
    );
    const desktopEntry = readFileSync(
      join(
        repositoryRoot,
        "linux/packaging/debian/ai.elizaos.app.desktop",
      ),
      "utf8",
    );
    const appstreamMetadata = readFileSync(
      join(
        repositoryRoot,
        "linux/packaging/debian/ai.elizaos.app.metainfo.xml",
      ),
      "utf8",
    );
    const autostart = readFileSync(
      join(
        repositoryRoot,
        "linux/packaging/debian/eliza-autostart",
      ),
      "utf8",
    );
    const autostartPreset = readFileSync(
      join(
        repositoryRoot,
        "linux/packaging/debian/80-elizaos.preset",
      ),
      "utf8",
    );
    const sessionTarget = readFileSync(
      join(
        repositoryRoot,
        "linux/packaging/debian/elizaos-session.target",
      ),
      "utf8",
    );
    const agentUnit = readFileSync(
      join(
        repositoryRoot,
        "linux/packaging/debian/elizaos-agent.service",
      ),
      "utf8",
    );
    const desktopUnit = readFileSync(
      join(
        repositoryRoot,
        "linux/packaging/debian/elizaos-desktop.service",
      ),
      "utf8",
    );

    expect(source).toContain("repository: elizaOS/eliza");
    expect(source).toContain("verify-desktop-artifact.py");
    expect(source).toContain("[A-Za-z0-9._-]*\\.(?:pem|key|der)");
    expect(source).toContain("upstream-ed25519-artifact");
    expect(source).not.toContain("Checkout application source");
    expect(source).not.toContain("bun install --cwd .eliza-source");
    expect(control).toContain("Architecture: any");
    expect(control).toContain("${shlibs:Depends}");
    expect(rules).toContain("cp -a payload/.");
    expect(rules).toContain("usr/lib/elizaos");
    expect(rules).toContain("ai.elizaos.app.desktop");
    expect(rules).toContain("ai.elizaos.app.metainfo.xml");
    expect(rules).toContain("ai.elizaos.app.svg");
    expect(rules).toContain("debian/validate-user-units");
    expect(rules).toContain("dh_installsystemduser --no-enable");
    expect(source).toContain("logo_blue_nobg.svg");
    expect(source).toContain("desktop-file-validate");
    expect(source).toContain("appstreamcli validate --no-net");
    expect(control).toContain("xdg-desktop-portal");
    expect(control).toContain("gnome-keyring");
    expect(control).toMatch(/^Build-Depends:.*\bsystemd\b/m);
    expect(desktopEntry).toContain("Exec=eliza-desktop %u");
    expect(desktopEntry).toContain("MimeType=x-scheme-handler/elizaos;");
    expect(desktopEntry).toContain("Icon=ai.elizaos.app");
    expect(appstreamMetadata).toContain("<id>ai.elizaos.app</id>");
    expect(appstreamMetadata).toContain(
      '<launchable type="desktop-id">ai.elizaos.app.desktop</launchable>',
    );
    expect(autostart).toContain("ELIZAOS_AUTOSTART_OWNER_REQUIRED");
    expect(autostart).toContain("ELIZAOS_AUTOSTART_SESSION_UNAVAILABLE");
    expect(autostart).toContain(
      "/usr/bin/systemctl --user enable --now elizaos-session.target",
    );
    expect(autostartPreset.trim()).toBe("disable elizaos-session.target");
    expect(sessionTarget).toContain("WantedBy=graphical-session.target");
    expect(agentUnit).toContain("ConditionFileIsExecutable=");
    expect(desktopUnit).toContain("ConditionFileIsExecutable=");
    expect(agentUnit).not.toContain("ConditionPathIsExecutable=");
    expect(desktopUnit).not.toContain("ConditionPathIsExecutable=");
    expect(agentUnit).toContain(
      "PartOf=graphical-session.target elizaos-session.target",
    );
    expect(desktopUnit).toContain(
      "PartOf=graphical-session.target elizaos-session.target",
    );
    expect(rules).not.toContain("/opt/elizaos");
    expect(rules).not.toContain("elizaos-app.mjs");
    expect(rules).not.toContain("node_modules");
    expect(source).toContain("extracted/usr/lib/elizaos");
    expect(source).not.toContain("extracted/opt/elizaos");
    for (const obsolete of ["install", "postinst", "prerm"]) {
      expect(
        existsSync(
          join(repositoryRoot, "linux/packaging/debian", obsolete),
        ),
      ).toBe(false);
    }
    const packagingDirectory = join(
      repositoryRoot,
      "linux/packaging/debian",
    );
    const packagingSource = readdirSync(packagingDirectory)
      .filter((name) => name !== "eliza-autostart")
      .map((name) => join(packagingDirectory, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(packagingSource).not.toContain("/opt/elizaos");
    expect(packagingSource).not.toContain("systemctl --user");
    expect(packages.map((artifact) => artifact.id).sort()).toEqual([
      "debian-package-amd64",
      "debian-package-arm64",
      "debian-package-riscv64",
    ]);
    expect(
      packages.map((artifact) => artifact.target.architecture).sort(),
    ).toEqual(["amd64", "arm64", "riscv64"]);
  });

  test("signed desktop distributors bind the protected release environment", () => {
    for (const name of [
      "release-elizaos-setup.yml",
      "release-usb-installer.yml",
    ]) {
      const workflow = parseWorkflow(name);
      const source = readFileSync(workflowPath(name), "utf8");

      expect(workflow.jobs?.build).toBeDefined();
      expect(source).toContain(
        "environment: ${{ inputs.require_signing && 'release' || '' }}",
      );
      expect(source).toContain("inputs.require_signing == true");
    }
    const usbSource = readFileSync(
      workflowPath("release-usb-installer.yml"),
      "utf8",
    );
    expect(usbSource).toContain("Configure pinned release-manifest trust root");
    expect(usbSource).toContain(
      "secrets.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64",
    );
    expect(usbSource).toContain(
      "secrets.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256",
    );
    expect(usbSource).toContain(
      "secrets.ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S",
    );
    expect(usbSource).toContain(
      "release public key does not match independently reviewed fingerprint",
    );
    expect(usbSource).toContain("release public key is revoked");
    expect(usbSource).toContain("ephemeral validation-only release trust root");
  });

  test("homepage release E2E resolves workspace Playwright and WebAuthn runtime inputs", () => {
    const homepagePackage = JSON.parse(
      readFileSync(
        join(repositoryRoot, "homepage/package.json"),
        "utf8",
      ),
    ) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(homepagePackage.scripts?.["test:e2e"]).toBe("playwright test");
    expect(homepagePackage.dependencies?.["@simplewebauthn/browser"]).toBe(
      "^13.0.0",
    );
    expect(homepagePackage.scripts?.deploy).toContain("wrangler pages deploy");
    expect(
      (homepagePackage as { devDependencies?: Record<string, string> })
        .devDependencies?.wrangler,
    ).toBe("4.123.0");

    const publisher = readFileSync(
      workflowPath("publish-os-homepage.yml"),
      "utf8",
    );
    expect(publisher).toContain("generate-os-homepage-data.mjs");
    expect(publisher).toContain("verify-release-checksums.mjs");
    expect(publisher).toContain("--require-distribution-signatures");
    expect(publisher).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(publisher).toContain("CLOUDFLARE_API_TOKEN");
    expect(publisher).toContain(
      ".result[0].deployment_trigger.metadata.commit_hash == $source",
    );

    const coordinator = readFileSync(
      workflowPath("elizaos-os-full-release.yml"),
      "utf8",
    );
    expect(coordinator).toContain("rehearse-homepage:");
    expect(coordinator).toContain("publish-homepage:");
    expect(coordinator).toContain(
      "if: inputs.publish == true && needs.publish-homepage.result == 'success'",
    );
  });

  test("latest Eliza source advances only through a recursive pinned PR", () => {
    const workflow = parseWorkflow("update-eliza-source-lock.yml");
    const source = readFileSync(
      workflowPath("update-eliza-source-lock.yml"),
      "utf8",
    );

    expect(workflow.permissions).toEqual({
      contents: "write",
      issues: "write",
      "pull-requests": "write",
    });
    expect(source).toContain("submodules: recursive");
    expect(source).toContain("update-eliza-source-lock.mjs");
    expect(source).toContain("gh pr create");
    expect(source).not.toContain("ref: develop");
  });

  test("every external action is pinned to an immutable commit", () => {
    for (const name of workflowNames()) {
      const workflow = parseWorkflow(name);
      const externalUses = Object.values(workflow.jobs ?? {}).flatMap((job) => [
        job.uses,
        ...(job.steps ?? []).map((step) => step.uses),
      ]);

      for (const uses of externalUses) {
        if (!uses || uses.startsWith("./")) continue;
        expect(uses).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      }
    }
  });

  test("every directly runnable job has an explicit timeout", () => {
    for (const name of workflowNames()) {
      const workflow = parseWorkflow(name);
      for (const job of Object.values(workflow.jobs ?? {})) {
        if (job.uses) continue;
        expect(job["timeout-minutes"]).toBeGreaterThan(0);
      }
    }
  });

  test("APT publication binds one signing key and deploys committed Pages content", () => {
    const workflow = parseWorkflow("publish-apt-repo.yml");
    const source = readFileSync(workflowPath("publish-apt-repo.yml"), "utf8");

    expect(workflow.permissions).toMatchObject({
      contents: "write",
      pages: "write",
      "id-token": "write",
    });
    expect(source).toContain(
      "DEBIAN_GPG_KEY_ID must be the full primary-key fingerprint",
    );
    expect(source).toContain(
      "Imported primary-key fingerprint does not match DEBIAN_GPG_KEY_ID",
    );
    expect(source).toContain("Expected exactly three Debian packages");
    expect(source).toContain("amd64|arm64|riscv64");
    expect(source).toContain("name: Validate GitHub Pages configuration");
    expect(source).toContain("if: inputs.dry_run != true");
    expect(source).toContain(
      'sed -i "s/^SignWith:.*/SignWith: $APT_GPG_FINGERPRINT/"',
    );
    expect(source).toContain("git -C apt-repo archive HEAD");
    expect(source).toContain(
      "actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b",
    );
    expect(source).toContain(
      "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
    );
    expect(source).toContain(
      "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
    );
    expect(source).toContain("Remove temporary signing material");
  });

  test("manual recovery binds immutable identities and opens a draft PR", () => {
    const workflow = parseWorkflow(recoveryWorkflow);
    const source = readFileSync(workflowPath(recoveryWorkflow), "utf8");

    expect(workflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(
      namedStep(
        workflow,
        "Bind base, tag, release, manifest, and asset identities",
      ).run,
    ).toContain("release-asset-inventory.mjs capture");
    expect(
      namedStep(workflow, "Download and verify the captured release asset set")
        .run,
    ).toContain("release-asset-inventory.mjs verify");
    expect(
      namedStep(workflow, "Open the draft checksum recovery pull request").run,
    ).toContain("gh pr create");
    expect(source).not.toContain("workflow_call:");
  });
});
