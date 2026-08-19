/**
 * Pins the composite workspace setup's protoc bootstrap policy. GitHub-hosted
 * lanes must bypass apt and use the checksummed release, while self-hosted
 * runners retain the bounded apt path and the same release fallback.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const actionPath = fileURLToPath(
  new URL(
    "../../../.github/actions/setup-bun-workspace/action.yml",
    import.meta.url,
  ),
);
const action = readFileSync(actionPath, "utf8");
const runnerEnvironmentExpression = "$" + "{{ runner.environment }}";
const runnerEnvironmentVariable = "$" + "{RUNNER_ENVIRONMENT}";
const protocChecksumVariable = "$" + "{protoc_sha256}";

describe("setup-bun-workspace protoc bootstrap", () => {
  test("routes hosted runners directly to the pinned release", () => {
    expect(action).toContain(
      `RUNNER_ENVIRONMENT: ${runnerEnvironmentExpression}`,
    );
    expect(action).toContain(
      `elif [ "${runnerEnvironmentVariable}" != "self-hosted" ]; then`,
    );
    expect(action).toContain(
      "using pinned protoc release on GitHub-hosted runner",
    );

    const hostedBranch = action.indexOf(
      `elif [ "${runnerEnvironmentVariable}" != "self-hosted" ]; then`,
    );
    const aptBranch = action.indexOf(
      "elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then",
    );
    expect(hostedBranch).toBeGreaterThan(-1);
    expect(aptBranch).toBeGreaterThan(hostedBranch);
  });

  test("keeps the fallback version and both architecture checksums pinned", () => {
    expect(action).toContain("protoc_version=27.3");
    expect(action).toContain(
      "6dab2adab83f915126cab53540d48957c40e9e9023969c3e84d44bfb936c7741",
    );
    expect(action).toContain(
      "bdad36f3ad7472281d90568c4956ea2e203c216e0de005c6bd486f1920f2751c",
    );
    expect(action).toContain(
      `echo "${protocChecksumVariable}  $dest/protoc.zip" | sha256sum -c -`,
    );
  });
});
