/** Exercises SHELL verification receipts with real command and output classification. */
import { describe, expect, it } from "vitest";
import { shellVerificationReceipt } from "./verification";

const receipt = (command: string, exitCode = 0, output = "", signal?: string) =>
  shellVerificationReceipt({ command, exitCode, output, signal });

describe("shell verification receipts", () => {
  it.each([
    "echo 'bun test'",
    "go test ./... || true",
    "go test ./... &",
    "go test ./... | tee log",
    "pytest --collect-only",
    "bun test --help",
    "tsc --version",
    "git status",
    "echo vitest",
    "printf 'git diff --check'",
    "test -f config.go",
    "[ -f config.go ]",
    "echo 'bun test packages/core'",
    "npm exec echo test",
    "printf 'safe && vitest'",
    "git diff --check",
    "go test ./...; true",
    "go test ./... | tee test.log",
    "git diff --check || echo ignored",
    "eslint --version",
    "biome --version",
    "pytest --help",
    "go test -h",
    "cargo test --help",
    "tox --help",
    "npx vitest --help",
    "pytest '--help'",
    'tsc "--version"',
    "npx vitest '--help'",
    "tsc --showConfig",
    "jest --showConfig",
  ])("does not attest inspection or masked execution: %s", (command) => {
    expect(receipt(command)).toBeUndefined();
  });
  it.each([
    "bun test",
    "npm run test",
    "go test ./...",
    "env CI=1 cargo test",
    "cd repo && pytest",
    "./gradlew test",
    "npx vitest",
    "bunx vitest",
    "uv run pytest",
    "poetry run pytest",
    "bundle exec rspec",
    "swift test",
    "mix test",
    "tox",
    "cd pkg && go test ./...",
    "go test ./... && tsc",
    "go test ./... 2>&1",
    "go test ./... &>test.log",
    "python -m pytest",
    "python -m unittest",
    "pnpm exec vitest",
    "npm exec vitest",
    "npx --yes vitest",
    "uv run python -m pytest",
    "cargo nextest run",
    "./gradlew :app:test",
    "./mvnw test",
    "export CGO_ENABLED=0 && go test ./...",
  ])("attests successful test execution: %s", (command) => {
    expect(receipt(command)).toMatchObject({
      kind: command === "tox" ? "other_verification" : "test",
      status: "passed",
      exitCode: 0,
    });
  });
  it("distinguishes a failed verifier from a missing executable or termination", () => {
    expect(receipt("bun test", 1, "assertion failed")).toMatchObject({
      status: "failed",
      exitCode: 1,
    });
    expect(receipt("bun test", 127)).toBeUndefined();
    expect(receipt("bun test", 137, "", "SIGKILL")).toBeUndefined();
  });
  it("reports empty Go test selection without discarding mixed real test runs", () => {
    const empty = "ok module/config 0.2s [no tests to run]";
    expect(receipt("go test ./...", 0, empty)).toMatchObject({
      status: "no_tests",
    });
    expect(
      receipt("go test ./...", 0, `${empty}\nok module/server 0.3s`),
    ).toMatchObject({ status: "passed" });
  });
});
