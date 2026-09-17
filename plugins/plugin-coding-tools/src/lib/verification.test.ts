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
  ])("does not attest inspection or masked execution: %s", (command) => {
    expect(receipt(command)).toBeUndefined();
  });
  it.each([
    "bun test",
    "npm run test",
    "go test ./...",
    "env CI=1 cargo test",
    "cd repo && pytest",
  ])("attests successful test execution: %s", (command) => {
    expect(receipt(command)).toMatchObject({
      kind: "test",
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
