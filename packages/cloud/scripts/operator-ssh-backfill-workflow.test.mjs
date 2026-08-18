import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const workflow = readFileSync(
  new URL("../../../.github/workflows/backfill-operator-ssh-key.yml", import.meta.url),
  "utf8",
);

describe("operator SSH backfill workflow", () => {
  test("is manual, protected, canonical-source-only, and count fenced", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: ${{ inputs.environment }}");
    expect(workflow).toContain('expected_ref="refs/heads/');
    expect(workflow).toContain('actual_count" != "$EXPECTED_HOST_COUNT"');
    expect(workflow).toContain("Unsupported environment and target-class combination");
  });

  test("requires independently pinned host keys and never weakens verification", () => {
    expect(workflow).toContain("ELIZA_OPERATOR_SSH_KNOWN_HOSTS");
    expect(workflow).toContain("ssh-keygen -F");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).not.toContain("StrictHostKeyChecking=no");
    expect(workflow).not.toContain("StrictHostKeyChecking=accept-new");
    expect(workflow).not.toContain("ssh-keyscan");
  });

  test("performs only an additive idempotent authorized_keys update", () => {
    expect(workflow).toContain('grep -qxF -- "$operator_key"');
    expect(workflow).toContain('>> "$HOME/.ssh/authorized_keys"');
    expect(workflow).not.toMatch(/(^|[^>])>\s*"\$HOME\/\.ssh\/authorized_keys"/m);
    expect(workflow).not.toContain("sed -i");
  });

  test("does not disclose selected addresses or private key material", () => {
    expect(workflow).toContain("addresses remain undisclosed");
    expect(workflow).not.toContain('echo "$host"');
    expect(workflow).not.toContain('echo "$PROVISIONING_SSH_KEY"');
    expect(workflow).not.toContain('echo "$CONTAINERS_SSH_KEY"');
    expect(workflow).not.toContain('echo "$APPS_SSH_KEY"');
  });
});
