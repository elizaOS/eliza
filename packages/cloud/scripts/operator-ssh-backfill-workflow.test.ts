/**
 * Exercises the protected operator-SSH backfill workflow and its checked-in
 * target resolver, public-key validator, and concurrency-safe installer.
 *
 * Functional fixtures execute the real shell boundaries against an isolated
 * fake Hetzner API so target authorization and adversarial file behavior are
 * tested without any cloud or host mutation.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(
  new URL(
    "../../../.github/workflows/backfill-operator-ssh-key.yml",
    import.meta.url,
  ),
  "utf8",
);
const installerPath = new URL(
  "./admin/install-operator-public-key.sh",
  import.meta.url,
).pathname;
const resolverPath = new URL(
  "./admin/resolve-operator-ssh-targets.sh",
  import.meta.url,
).pathname;
const validatorPath = new URL(
  "./admin/validate-operator-public-key.sh",
  import.meta.url,
).pathname;
const operatorKey = "ssh-ed25519 AAAATESTONLYOPERATORKEY operator@test";
const githubExpression = (expression) => `$${`{{ ${expression} }}`}`;
const shellUrlSuffix = `$${"{url##*/}"}`;

function installerEnvironment(home, key = operatorKey) {
  return {
    HOME: home,
    PATH: process.env.PATH,
    OPERATOR_KEY_BASE64: Buffer.from(key).toString("base64"),
  };
}

function runInstaller(home, key = operatorKey) {
  return Bun.spawnSync(["bash", installerPath], {
    env: installerEnvironment(home, key),
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
    expect(workflow).toContain(
      `environment: ${githubExpression("inputs.environment")}`,
    );
    expect(workflow).toContain("environment: staging-approval");
    expect(workflow).toContain("needs: [staging-approval]");
    expect(workflow).toContain("needs.staging-approval.result == 'success'");
    expect(workflow).toContain('expected_ref="refs/heads/');
    expect(workflow).toContain('actual_count" != "$EXPECTED_HOST_COUNT"');
    expect(workflow).toContain(
      "Unsupported environment and target-class combination",
    );
    expect(workflow).toContain("ELIZA_OPERATOR_DATA_PLANE_SERVER_IDS");
    expect(workflow).toContain("ELIZA_OPERATOR_APPS_SERVER_IDS");
    expect(workflow).toContain(
      "packages/cloud/scripts/admin/resolve-operator-ssh-targets.sh",
    );
    expect(workflow).not.toContain("per_page=");
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
    expect(workflow).toContain(
      `PROJECT_HCLOUD_TOKEN: ${githubExpression("secrets.HCLOUD_TOKEN")}`,
    );
    expect(workflow).toContain(
      `APPS_HCLOUD_TOKEN: ${githubExpression("secrets.HCLOUD_APPS_TOKEN")}`,
    );
    expect(workflow).not.toMatch(/HCLOUD_APPS_TOKEN\s*\|\|/);
    expect(workflow).not.toMatch(/HCLOUD_APPS_TOKEN\s*&&/);
  });

  test("validates a single wire-format ED25519 key with ssh-keygen", () => {
    expect(workflow).toContain(
      "packages/cloud/scripts/admin/validate-operator-public-key.sh",
    );
    expect(workflow).not.toContain("[A-Za-z0-9+/]");
  });

  test("keeps secret values out of job scope and non-shell actions", () => {
    const jobEnv = workflow.slice(
      workflow.indexOf("    env:\n"),
      workflow.indexOf("    steps:\n"),
    );
    expect(jobEnv).not.toContain("secrets.");
    expect(workflow).toContain(
      `HAS_APPS_HCLOUD_TOKEN: ${githubExpression("secrets.HCLOUD_APPS_TOKEN != ''")}`,
    );
    expect(workflow).not.toContain("ELIZA_OPERATOR_PIN_ARTIFACT_KEY");
  });

  test("uses the checked-in atomic installer and keeps targets out of logs", () => {
    expect(workflow).toContain(
      "packages/cloud/scripts/admin/install-operator-public-key.sh",
    );
    expect(workflow).toContain("addresses remain undisclosed");
    expect(workflow).toContain("failed for one undisclosed target");
    expect(workflow).toContain('2>"$ssh_error_path"');
    expect(workflow).toContain("ProxyCommand=$proxy_command");
    expect(workflow).not.toContain('echo "$host"');
  });
});

describe("immutable operator target resolver", () => {
  test("resolves only approved IDs and rejects malformed or role-mismatched inventories", () => {
    withTempHome((home) => {
      const mockBin = join(home, "bin");
      const fixtures = join(home, "servers");
      mkdirSync(mockBin);
      mkdirSync(fixtures);
      const mockCurl = join(mockBin, "curl");
      writeFileSync(
        mockCurl,
        `#!/bin/sh\nfor argument do url="$argument"; done\nid="${shellUrlSuffix}"\ncase "$id" in *[!0-9]*|"") exit 2 ;; esac\ncat "$MOCK_SERVER_DIR/$id.json"\n`,
        { mode: 0o700 },
      );
      const fixture = (id, name, role, publicIp, privateIp = null) =>
        writeFileSync(
          join(fixtures, `${id}.json`),
          JSON.stringify({
            server: {
              id,
              name,
              status: "running",
              labels: role ? { role } : {},
              public_net: { ipv4: { ip: publicIp } },
              private_net: privateIp ? [{ ip: privateIp }] : [],
            },
          }),
        );
      fixture(101, "eliza-core-1a2b3c4d", null, "192.0.2.101");
      fixture(102, "eliza-core-5e6f7a8b", null, "192.0.2.102");
      fixture(999, "unrelated", null, "192.0.2.199");

      const output = join(home, "targets");
      const environment = {
        PATH: `${mockBin}:${process.env.PATH}`,
        MOCK_SERVER_DIR: fixtures,
        TARGET_CLASS: "data-plane",
        EXPECTED_HOST_COUNT: "2",
        CONTROL_HOST: "192.0.2.10",
        APPROVED_SERVER_IDS: "101\n102",
        PROJECT_HCLOUD_TOKEN: "test-token",
        OUTPUT_PATH: output,
      };
      expect(
        Bun.spawnSync(["bash", resolverPath], { env: environment }).exitCode,
      ).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(
        "192.0.2.101\tdirect\n192.0.2.102\tdirect\n",
      );

      expect(
        Bun.spawnSync(["bash", resolverPath], {
          env: { ...environment, APPROVED_SERVER_IDS: "101\nnot-an-id" },
        }).exitCode,
      ).not.toBe(0);
      expect(
        Bun.spawnSync(["bash", resolverPath], {
          env: { ...environment, APPROVED_SERVER_IDS: "101\n999" },
        }).exitCode,
      ).not.toBe(0);
    });
  });

  test("requires every approved apps ID and derives exactly one direct route", () => {
    withTempHome((home) => {
      const mockBin = join(home, "bin");
      const fixtures = join(home, "servers");
      mkdirSync(mockBin);
      mkdirSync(fixtures);
      const mockCurl = join(mockBin, "curl");
      writeFileSync(
        mockCurl,
        `#!/bin/sh\nfor argument do url="$argument"; done\nid="${shellUrlSuffix}"\ncat "$MOCK_SERVER_DIR/$id.json"\n`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(fixtures, "201.json"),
        JSON.stringify({
          server: {
            id: 201,
            name: "control",
            status: "running",
            labels: { role: "apps-control" },
            public_net: { ipv4: { ip: "192.0.2.201" } },
            private_net: [{ ip: "10.0.0.1" }],
          },
        }),
      );
      writeFileSync(
        join(fixtures, "202.json"),
        JSON.stringify({
          server: {
            id: 202,
            name: "worker",
            status: "running",
            labels: { role: "apps-worker" },
            public_net: { ipv4: { ip: "192.0.2.202" } },
            private_net: [{ ip: "10.0.0.2" }],
          },
        }),
      );
      const output = join(home, "targets");
      const result = Bun.spawnSync(["bash", resolverPath], {
        env: {
          PATH: `${mockBin}:${process.env.PATH}`,
          MOCK_SERVER_DIR: fixtures,
          TARGET_CLASS: "apps",
          EXPECTED_HOST_COUNT: "2",
          CONTROL_HOST: "192.0.2.201",
          APPROVED_SERVER_IDS: "201\n202",
          PROJECT_HCLOUD_TOKEN: "test-token",
          OUTPUT_PATH: output,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(
        "10.0.0.2\tproxy\n192.0.2.201\tdirect\n",
      );
    });
  });
});

describe("operator public-key validator", () => {
  test("accepts one real ED25519 public key and rejects malformed or multiple keys", () => {
    withTempHome((home) => {
      const privatePath = join(home, "test-operator");
      const generated = Bun.spawnSync([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        privatePath,
      ]);
      expect(generated.exitCode).toBe(0);
      const publicPath = `${privatePath}.pub`;
      expect(Bun.spawnSync(["bash", validatorPath, publicPath]).exitCode).toBe(
        0,
      );

      const malformedPath = join(home, "malformed.pub");
      writeFileSync(malformedPath, "ssh-ed25519 AAAATESTONLY malformed@test\n");
      expect(
        Bun.spawnSync(["bash", validatorPath, malformedPath]).exitCode,
      ).not.toBe(0);

      const multiplePath = join(home, "multiple.pub");
      const valid = readFileSync(publicPath, "utf8");
      writeFileSync(multiplePath, `${valid}${valid}`);
      expect(
        Bun.spawnSync(["bash", validatorPath, multiplePath]).exitCode,
      ).not.toBe(0);

      const keyFields = valid.trimEnd().split(/\s+/).slice(0, 2).join(" ");
      const knownHostsPath = join(home, "known-host-shaped.pub");
      writeFileSync(knownHostsPath, `example.invalid ${keyFields}\n`);
      expect(
        Bun.spawnSync(["bash", validatorPath, knownHostsPath]).exitCode,
      ).not.toBe(0);

      const optionsPath = join(home, "authorized-key-options.pub");
      writeFileSync(optionsPath, `restrict ${keyFields}\n`);
      expect(
        Bun.spawnSync(["bash", validatorPath, optionsPath]).exitCode,
      ).not.toBe(0);

      const commentedPath = join(home, "commented.pub");
      writeFileSync(
        commentedPath,
        `${keyFields} operator comment is allowed\n`,
      );
      expect(
        Bun.spawnSync(["bash", validatorPath, commentedPath]).exitCode,
      ).toBe(0);
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
      expect(lstatSync(join(sshDir, "authorized_keys")).isDirectory()).toBe(
        true,
      );
    });
  });

  test("preserves an append from a writer that does not honor the installer lock", () => {
    withTempHome((home) => {
      const sshDir = join(home, ".ssh");
      mkdirSync(sshDir, { mode: 0o700 });
      const path = join(sshDir, "authorized_keys");
      const existing = "ssh-ed25519 AAAAEXISTING existing@test";
      const externalKey = "ssh-ed25519 AAAAEXTERNAL external@test";
      writeFileSync(path, `${existing}\n`, { mode: 0o600 });

      const mockBin = join(home, "bin");
      mkdirSync(mockBin);
      const marker = join(home, "external-append-complete");
      const chmodWrapper = join(mockBin, "chmod");
      writeFileSync(
        chmodWrapper,
        `#!/bin/sh
if [ "$1" = 0600 ] && [ ! -e "$EXTERNAL_APPEND_MARKER" ]; then
  printf '%s\\n' "$EXTERNAL_APPEND_KEY" >> "$EXTERNAL_APPEND_TARGET"
  : > "$EXTERNAL_APPEND_MARKER"
fi
exec "$REAL_CHMOD" "$@"
`,
        { mode: 0o700 },
      );

      const result = Bun.spawnSync(["bash", installerPath], {
        env: {
          ...installerEnvironment(home),
          PATH: `${mockBin}:${process.env.PATH}`,
          EXTERNAL_APPEND_KEY: externalKey,
          EXTERNAL_APPEND_MARKER: marker,
          EXTERNAL_APPEND_TARGET: path,
          REAL_CHMOD: Bun.which("chmod"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(path, "utf8").trimEnd().split("\n")).toEqual([
        existing,
        externalKey,
        operatorKey,
      ]);
    });
  });

  test("serializes concurrent additive writers without losing either key", async () => {
    const home = mkdtempSync(join(tmpdir(), "eliza-operator-key-test-"));
    try {
      const sshDir = join(home, ".ssh");
      mkdirSync(sshDir, { mode: 0o700 });
      const path = join(sshDir, "authorized_keys");
      const existing = "ssh-ed25519 AAAAEXISTING existing@test";
      const firstKey = "ssh-ed25519 AAAAFIRST first@test";
      const secondKey = "ssh-ed25519 AAAASECOND second@test";
      writeFileSync(path, existing, { mode: 0o600 });

      const first = Bun.spawn(["bash", installerPath], {
        env: installerEnvironment(home, firstKey),
        stdout: "pipe",
        stderr: "pipe",
      });
      const second = Bun.spawn(["bash", installerPath], {
        env: installerEnvironment(home, secondKey),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);

      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      expect(lines[0]).toBe(existing);
      expect(new Set(lines.slice(1))).toEqual(new Set([firstKey, secondKey]));
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
