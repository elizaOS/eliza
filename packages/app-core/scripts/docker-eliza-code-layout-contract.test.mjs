/**
 * Clean-context contracts for packaging Eliza Code in both supported Docker
 * repository layouts. These checks are intentionally source-level: they run
 * without Docker and catch a missing build/copy/smoke edge before the expensive
 * image job starts.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..", "..", "..");
const read = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("Eliza Code canonical Docker packaging", () => {
  it("derives Eliza Code from PACKAGES_DIR in flat and nested builders and builds its dist", () => {
    const smoke = read("packages/app-core/scripts/docker-ci-smoke.sh");
    const legacyBuilder = read("packages/app-core/scripts/build-image.sh");

    expect(smoke).toContain('ELIZA_CODE_DIR="$PACKAGES_DIR/examples/code"');
    expect(smoke).toContain('pushd "$ELIZA_CODE_DIR"');
    expect(smoke).toContain('"$BUN_BIN" run build');
    expect(smoke).toContain('--build-arg "ELIZA_CODE_DIR=$ELIZA_CODE_DIR"');

    expect(legacyBuilder).toContain('PACKAGES_DIR="eliza/packages"');
    expect(legacyBuilder).toContain(
      'ELIZA_CODE_DIR="$PACKAGES_DIR/examples/code"',
    );
    expect(legacyBuilder).toMatch(
      /run "cd \$\{ELIZA_CODE_DIR\} && bun run build/,
    );
    expect(legacyBuilder).toMatch(
      /"--build-arg" "ELIZA_CODE_DIR=\$\{ELIZA_CODE_DIR\}"/,
    );
  });

  it("keeps the exact nested Eliza Code package in the canonical Docker context", () => {
    const dockerignore = read("packages/app-core/deploy/.dockerignore.ci");
    expect(dockerignore).toContain("eliza/packages/examples\n");
    expect(dockerignore).toContain("!eliza/packages/examples/\n");
    expect(dockerignore).toContain("!eliza/packages/examples/code/\n");
    expect(dockerignore).toContain("!eliza/packages/examples/code/**\n");
  });

  it("parameterizes every Dockerfile Eliza Code path and exposes both entrypoints", () => {
    const dockerfile = read("packages/app-core/deploy/Dockerfile.ci");
    const entrypoint = read("packages/app-core/scripts/docker-entrypoint.sh");
    expect(dockerfile).toContain("ARG ELIZA_CODE_DIR=packages/examples/code");
    expect(dockerfile).toMatch(
      /test -s "\$\{ELIZA_CODE_DIR\}\/dist\/index\.js"/,
    );
    expect(dockerfile).toMatch(/test -s "\$\{ELIZA_CODE_DIR\}\/dist\/acp\.js"/);
    expect(dockerfile).toMatch(
      /ln -s "\/app\/\$\{ELIZA_CODE_DIR\}\/dist\/index\.js"/,
    );
    expect(dockerfile).toMatch(
      /ln -s "\/app\/\$\{ELIZA_CODE_DIR\}\/dist\/acp\.js"/,
    );
    expect(dockerfile).not.toMatch(/test -s packages\/examples\/code/);
    expect(dockerfile).toContain("ENV ELIZA_RUNTIME_UID=10001");
    expect(dockerfile).toContain("util-linux");
    expect(entrypoint).toContain("start_tailscale_if_configured");
    expect(entrypoint).toContain("drop_to_runtime_user");
    expect(entrypoint).toContain("exec setpriv");
    expect(entrypoint.indexOf("start_tailscale_if_configured")).toBeLessThan(
      entrypoint.indexOf('drop_to_runtime_user "$@"'),
    );
  });

  it("quarantines the patched Smithers runtime without shipping its coding CLI", () => {
    const dockerfile = read("packages/app-core/deploy/Dockerfile.ci");
    const smoke = read("packages/app-core/scripts/docker-ci-smoke.sh");
    const legacyBuilder = read("packages/app-core/scripts/build-image.sh");

    expect(dockerfile).toContain("ARG PATCHES_DIR");
    expect(dockerfile).toContain("@smthrs%2Fagents@0.34.0.patch");
    expect(dockerfile).toContain("@smthrs%2Fengine@0.34.0.patch");
    expect(dockerfile).toContain("smthrs@0.34.0.patch");
    expect(dockerfile).toContain("/deps/node_modules/@smthrs/cli");
    expect(dockerfile).toContain("/deps/node_modules/.bin/smithers");
    expect(smoke).toContain('PATCHES_DIR="patches"');
    expect(smoke).toContain('PATCHES_DIR="eliza/patches"');
    expect(smoke).toContain('--build-arg "PATCHES_DIR=$PATCHES_DIR"');
    expect(legacyBuilder).toContain('PATCHES_DIR="eliza/patches"');
    expect(legacyBuilder).toMatch(
      /"--build-arg" "PATCHES_DIR=\$\{PATCHES_DIR\}"/,
    );
  });

  it("gates publication on the real bubblewrap SHELL boundary under hosted security flags", () => {
    const smoke = read("packages/app-core/scripts/docker-ci-smoke.sh");
    const workflow = read(".github/workflows/build-agent-image.yml");
    const apparmor = read(
      "packages/cloud/shared/src/lib/services/hosted-agent-bwrap.apparmor",
    );
    const apparmorSha = createHash("sha256").update(apparmor).digest("hex");
    expect(smoke).toContain("--cap-drop=ALL");
    expect(smoke).toContain("--user 10001:10001");
    expect(smoke).toContain("--security-opt no-new-privileges");
    expect(smoke).toContain(
      '--security-opt "seccomp=$REPO_ROOT/$HOSTED_AGENT_SECCOMP_PROFILE"',
    );
    expect(smoke).toContain(
      '--security-opt "apparmor=$HOSTED_AGENT_APPARMOR_PROFILE_NAME"',
    );
    expect(smoke).toContain("apparmor_parser");
    expect(smoke).toContain("(enforce)");
    expect(smoke).toContain(
      `HOSTED_AGENT_APPARMOR_PROFILE_SHA256="${apparmorSha}"`,
    );
    expect(smoke).not.toContain("apparmor=unconfined");
    expect(smoke).not.toContain("seccomp=unconfined");
    expect(apparmor).toContain("@{PROC}/sys/user/max_user_namespaces w,");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("--no-install-recommends apparmor jq");
    expect(workflow).toContain("docker-ci-smoke.sh --boot-verify-only");
    expect(smoke).toContain("import { runShell }");
    expect(smoke).toContain('inside.sandbox !== "bubblewrap"');
    expect(smoke).toContain('outside.sandbox !== "bubblewrap"');
    expect(smoke).toContain("verify_eliza_code_shell");
    expect(smoke).toContain("Hosted agent PID 1 retained Linux capabilities");
  });
});
