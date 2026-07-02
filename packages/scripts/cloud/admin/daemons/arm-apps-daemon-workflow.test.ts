import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/arm-apps-daemon.yml",
);
const scriptPath = path.join(
  repoRoot,
  "packages/scripts/cloud/admin/arm-apps-daemon.mjs",
);

const workflow = readFileSync(workflowPath, "utf8");
const localScript = readFileSync(scriptPath, "utf8");

describe("arm-apps-daemon.yml container SSH key wiring", () => {
  it("sources container SSH key material from the dedicated secret or the target deploy key", () => {
    expect(workflow).toContain("CONTAINERS_SSH_KEY_INPUT:");
    expect(workflow).toContain("secrets.CONTAINERS_SSH_KEY");
    expect(workflow).toContain("secrets.ELIZA_APPS_WORKER_SSH_KEY");
    expect(workflow).toContain("secrets.ELIZA_PROVISIONING_SSH_KEY");
  });

  it("fails preflight when no container SSH key material is available", () => {
    expect(workflow).toContain('[ -n "$CONTAINERS_SSH_KEY_INPUT" ]');
    expect(workflow).toContain("missing container SSH key material");
  });

  it("normalizes raw or already-base64 key material to a single-line base64 env value", () => {
    expect(workflow).toContain("Prepare container SSH key");
    expect(workflow).toContain('base64 -d >"$tmp"');
    expect(workflow).toContain("base64 -w0");
    expect(workflow).toContain(
      "CONTAINERS_SSH_KEY_B64=$containers_ssh_key_b64",
    );
  });

  it("forwards the normalized key through ssh-action and writes CONTAINERS_SSH_KEY remotely", () => {
    const envsLine = workflow
      .split("\n")
      .find(
        (line) =>
          line.trim().startsWith("envs:") &&
          line.includes("CONTAINERS_SSH_KEY_B64"),
      );
    expect(envsLine).toBeDefined();
    expect(workflow).toContain(
      'upsert CONTAINERS_SSH_KEY "$CONTAINERS_SSH_KEY_B64"',
    );
  });

  it("shows CONTAINERS_SSH_KEY only through the redacted grep output", () => {
    expect(workflow).toContain("SSH_KEY");
    expect(workflow).toContain("sed -E 's/(DSN|KEY)=.*/\\1=<redacted>/'");
  });
});

describe("arm-apps-daemon.mjs container SSH key parity", () => {
  it("lets local arming write CONTAINERS_SSH_KEY as base64 or CONTAINERS_SSH_KEY_PATH", () => {
    expect(localScript).toContain("--node-ssh-key-base64");
    expect(localScript).toContain(
      'CONTAINERS_SSH_KEY: args["node-ssh-key-base64"]',
    );
    expect(localScript).toContain(
      'CONTAINERS_SSH_KEY_PATH: args["node-ssh-key-path"]',
    );
  });
});
