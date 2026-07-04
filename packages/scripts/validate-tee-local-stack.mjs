#!/usr/bin/env node
// Drives repo automation validate tee local stack with explicit CLI and CI behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const outputPath = path.join(
  repoRoot,
  "evidence/tee/local-stack-validation-2026-05-20.json",
);

const checks = [
  {
    id: "agent-tee-vitest",
    command: "bunx",
    args: [
      "vitest",
      "run",
      "--config",
      "packages/agent/vitest.config.ts",
      "packages/agent/src/services/tee-policy.test.ts",
      "packages/agent/src/services/dstack-tee-provider.test.ts",
      "packages/agent/src/services/remote-capability-tee-policy.test.ts",
      "packages/agent/src/services/tee-signer-backend.test.ts",
      "packages/agent/src/services/tee-key-release.test.ts",
      "packages/agent/src/services/tee-release-policy.test.ts",
      "packages/agent/src/services/tee-revocation.test.ts",
      "packages/agent/src/services/tee-runtime-config.test.ts",
      "--coverage.enabled=false",
    ],
  },
  {
    id: "agent-typecheck",
    command: "bun",
    args: ["run", "--cwd", "packages/agent", "typecheck"],
  },
  {
    id: "agent-tee-biome",
    command: "bunx",
    args: [
      "@biomejs/biome",
      "check",
      "packages/agent/scripts/tee-local-smoke.ts",
      "packages/agent/scripts/tee-full-stack-local.ts",
      "packages/agent/src/services/tee-evidence.ts",
      "packages/agent/src/services/tee-policy.ts",
      "packages/agent/src/services/dstack-tee-provider.ts",
      "packages/agent/src/services/tee-signer-backend.ts",
      "packages/agent/src/services/tee-key-release.ts",
      "packages/agent/src/services/tee-release-policy.ts",
      "packages/agent/src/services/tee-revocation.ts",
      "packages/agent/src/services/tee-runtime-config.ts",
      "packages/agent/src/services/tee-policy.test.ts",
      "packages/agent/src/services/dstack-tee-provider.test.ts",
      "packages/agent/src/services/remote-capability-tee-policy.test.ts",
      "packages/agent/src/services/tee-signer-backend.test.ts",
      "packages/agent/src/services/tee-key-release.test.ts",
      "packages/agent/src/services/tee-release-policy.test.ts",
      "packages/agent/src/services/tee-revocation.test.ts",
      "packages/agent/src/services/tee-runtime-config.test.ts",
      "packages/agent/src/services/remote-capability-endpoint-provider.ts",
      "packages/agent/src/index.ts",
    ],
  },
  {
    id: "agent-tee-deployment-manifest",
    command: "node",
    args: [
      "packages/agent/scripts/validate-tee-deployment.mjs",
      "packages/agent/tee/dstack-agent-deployment.example.json",
      "packages/agent/tee/revocations.example.json",
    ],
  },
  {
    id: "agent-tee-revocations",
    command: "node",
    args: ["packages/agent/scripts/validate-tee-revocations.mjs"],
  },
  {
    id: "os-release-tests",
    command: "node",
    args: [
      "--test",
      "packages/os/scripts/__tests__/os-release-scripts.test.mjs",
    ],
  },
  {
    id: "os-tee-measurements-validator",
    command: "node",
    args: ["packages/os/scripts/validate-tee-measurements.mjs"],
  },
  {
    id: "os-release-schema-json",
    command: "node",
    args: [
      "-e",
      "JSON.parse(require('fs').readFileSync('packages/os/release/schema/elizaos-os-release-manifest.schema.json','utf8')); console.log('schema json valid')",
    ],
  },
  {
    id: "chip-confidential-domain-contract",
    command: "python3",
    args: [
      "packages/research/chip/scripts/check_tee_confidential_domain_contract.py",
    ],
    env: { PYTHONDONTWRITEBYTECODE: "1" },
  },
  {
    id: "chip-iopmp-policy",
    command: "python3",
    args: ["packages/research/chip/scripts/check_tee_iopmp_policy.py"],
    env: { PYTHONDONTWRITEBYTECODE: "1" },
  },
  {
    id: "chip-page-state-policy",
    command: "python3",
    args: ["packages/research/chip/scripts/check_tee_page_state_policy.py"],
    env: { PYTHONDONTWRITEBYTECODE: "1" },
  },
  {
    id: "chip-attestation-evidence",
    command: "python3",
    args: ["packages/research/chip/scripts/check_tee_attestation_evidence.py"],
    env: { PYTHONDONTWRITEBYTECODE: "1" },
  },
  {
    id: "chip-side-channel-claims",
    command: "python3",
    args: ["packages/research/chip/scripts/check_tee_side_channel_claims.py"],
    env: { PYTHONDONTWRITEBYTECODE: "1" },
  },
  {
    id: "agent-local-tee-smoke",
    command: "bun",
    args: ["run", "packages/agent/scripts/tee-local-smoke.ts"],
  },
  {
    id: "agent-full-stack-local-smoke",
    command: "bun",
    args: ["run", "packages/agent/scripts/tee-full-stack-local.ts"],
  },
];

const startedAt = new Date().toISOString();
const results = checks.map(runCheck);
const ok = results.every((result) => result.exitCode === 0);
const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  startedAt,
  platform: process.platform,
  arch: process.arch,
  ok,
  checks: results,
  deferredBareMetalGates: [
    "dstack-cvm-launch",
    "tdx-or-sev-snp-hardware-quote",
    "nvidia-confidential-gpu-attestation",
    "android-avf-pkvm-protected-vm-quote",
    "riscv-cove-or-salus-confidential-linux-boot",
    "rtl-or-fpga-iopmp-dma-isolation",
    "external-memory-encryption-integrity",
    "npu-private-queue-isolation",
    "physical-side-channel-and-tamper-validation",
  ],
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);

for (const result of results) {
  const status = result.exitCode === 0 ? "ok" : `failed:${result.exitCode}`;
  console.log(`${status} ${result.id}`);
}
console.log(`TEE local stack validation written: ${outputPath}`);

if (!ok) {
  process.exit(1);
}

function runCheck(check) {
  const startedAtMs = Date.now();
  const child = spawnSync(check.command, check.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(check.env ?? {}) },
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    id: check.id,
    command: [check.command, ...check.args].join(" "),
    exitCode: child.status ?? 1,
    durationMs: Date.now() - startedAtMs,
    stdoutTail: tail(child.stdout),
    stderrTail: tail(child.stderr),
  };
}

function tail(value) {
  const text = String(value ?? "").trim();
  if (text.length <= 4000) return text;
  return text.slice(text.length - 4000);
}
