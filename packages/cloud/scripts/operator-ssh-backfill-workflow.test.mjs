import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const workflow = readFileSync(
  new URL("../../../.github/workflows/backfill-operator-ssh-key.yml", import.meta.url),
  "utf8",
);
const installerPath = new URL("./admin/install-operator-public-key.sh", import.meta.url).pathname;
const validatorPath = new URL("./admin/validate-operator-public-key.sh", import.meta.url).pathname;
const operatorKey = "ssh-ed25519 AAAATESTONLYOPERATORKEY operator@test";

function runInstaller(home) {
  return Bun.spawnSync(["bash", installerPath], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      OPERATOR_KEY_BASE64: Buffer.from(operatorKey).toString("base64"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function withTempHome(run) {
  const home = mkdtempSync(join(tmpdir(), "eliza-operator-key-test-"));
  try {
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("operator SSH backfill workflow", () => {
  test("is manual, protected, canonical-source-only, and count fenced", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: ${{ inputs.environment }}");
    expect(workflow).toContain('expected_ref="refs/heads/');
    expect(workflow).toContain('actual_count" != "$EXPECTED_HOST_COUNT"');
    expect(workflow).toContain("Unsupported environment and target-class combination");
    expect(workflow).toContain('select(.public_net.ipv4.ip != $control_host)');
  });

  test("requires pre-established pins and has no trust-on-first-use path", () => {
    expect(workflow).toContain("ELIZA_OPERATOR_SSH_KNOWN_HOSTS");
    expect(workflow).toContain("ssh-keygen -F");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).not.toContain("StrictHostKeyChecking=no");
    expect(workflow).not.toContain("StrictHostKeyChecking=accept-new");
    expect(workflow).not.toContain("ssh-keyscan");
    expect(workflow).not.toContain("upload-artifact");
  });

  test("selects exact project credentials with no fallback", () => {
    expect(workflow).toContain("PROJECT_HCLOUD_TOKEN: ${{ secrets.HCLOUD_TOKEN }}");
    expect(workflow).toContain("APPS_HCLOUD_TOKEN: ${{ secrets.HCLOUD_APPS_TOKEN }}");
    expect(workflow).not.toMatch(/HCLOUD_APPS_TOKEN\s*\|\|/);
    expect(workflow).not.toMatch(/HCLOUD_APPS_TOKEN\s*&&/);
  });

  test("validates a single wire-format ED25519 key with ssh-keygen", () => {
    expect(workflow).toContain("packages/cloud/scripts/admin/validate-operator-public-key.sh");
    expect(workflow).not.toContain("[A-Za-z0-9+/]");
  });

  test("keeps secret values out of job scope and non-shell actions", () => {
    const jobEnv = workflow.slice(workflow.indexOf("    env:\n"), workflow.indexOf("    steps:\n"));
    expect(jobEnv).not.toContain("secrets.");
    expect(workflow).toContain("HAS_APPS_HCLOUD_TOKEN: ${{ secrets.HCLOUD_APPS_TOKEN != '' }}");
    expect(workflow).not.toContain("ELIZA_OPERATOR_PIN_ARTIFACT_KEY");
  });

  test("uses the checked-in atomic installer and keeps targets out of logs", () => {
    expect(workflow).toContain("packages/cloud/scripts/admin/install-operator-public-key.sh");
    expect(workflow).toContain("addresses remain undisclosed");
    expect(workflow).toContain("failed for one undisclosed target");
    expect(workflow).toContain('2>"$ssh_error_path"');
    expect(workflow).toContain("ProxyCommand=$proxy_command");
    expect(workflow).not.toContain('echo "$host"');
  });
});

describe("operator public-key validator", () => {
  test("accepts one real ED25519 public key and rejects malformed or multiple keys", () => {
    withTempHome((home) => {
      const privatePath = join(home, "test-operator");
      const generated = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", privatePath]);
      expect(generated.exitCode).toBe(0);
      const publicPath = `${privatePath}.pub`;
      expect(Bun.spawnSync(["bash", validatorPath, publicPath]).exitCode).toBe(0);

      const malformedPath = join(home, "malformed.pub");
      writeFileSync(malformedPath, "ssh-ed25519 AAAATESTONLY malformed@test\n");
      expect(Bun.spawnSync(["bash", validatorPath, malformedPath]).exitCode).not.toBe(0);

      const multiplePath = join(home, "multiple.pub");
      const valid = readFileSync(publicPath, "utf8");
      writeFileSync(multiplePath, `${valid}${valid}`);
      expect(Bun.spawnSync(["bash", validatorPath, multiplePath]).exitCode).not.toBe(0);
    });
  });
});

describe("atomic operator public-key installer", () => {
  test("creates a missing authorized_keys with secure permissions", () => {
    withTempHome((home) => {
      const result = runInstaller(home);
      expect(result.exitCode).toBe(0);
      const path = join(home, ".ssh", "authorized_keys");
      expect(readFileSync(path, "utf8")).toBe(`${operatorKey}\n`);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    });
  });

  test("preserves a final line without newline before appending", () => {
    withTempHome((home) => {
      const sshDir = join(home, ".ssh");
      mkdirSync(sshDir, { mode: 0o700 });
      const path = join(sshDir, "authorized_keys");
      const existing = "ssh-ed25519 AAAAEXISTING existing@test";
      writeFileSync(path, existing, { mode: 0o600 });
      const result = runInstaller(home);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(`${existing}\n${operatorKey}\n`);
    });
  });

  test("is byte-idempotent when the exact key already exists", () => {
    withTempHome((home) => {
      const sshDir = join(home, ".ssh");
      mkdirSync(sshDir, { mode: 0o700 });
      const path = join(sshDir, "authorized_keys");
      const before = `ssh-ed25519 AAAAEXISTING existing@test\n${operatorKey}\n`;
      writeFileSync(path, before, { mode: 0o644 });
      const result = runInstaller(home);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    });
  });

  test("rejects a symlink without changing its target", () => {
    withTempHome((home) => {
      const sshDir = join(home, ".ssh");
      mkdirSync(sshDir, { mode: 0o700 });
      const external = join(home, "external-keys");
      writeFileSync(external, "unchanged", { mode: 0o600 });
      symlinkSync(external, join(sshDir, "authorized_keys"));
      const result = runInstaller(home);
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(external, "utf8")).toBe("unchanged");
    });
  });

  test("rejects a non-regular destination", () => {
    withTempHome((home) => {
      const sshDir = join(home, ".ssh");
      mkdirSync(join(sshDir, "authorized_keys"), { recursive: true });
      chmodSync(sshDir, 0o700);
      const result = runInstaller(home);
      expect(result.exitCode).not.toBe(0);
      expect(lstatSync(join(sshDir, "authorized_keys")).isDirectory()).toBe(true);
    });
  });
});
