import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReference } from "../src/password-managers.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);
type ExecFileCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: unknown,
  stderr: string,
) => void;

function resolveExec(stdout: string): void {
  execFileMock.mockImplementation((((
    _cmd: string,
    _args: readonly string[],
    _opts: Record<string, unknown>,
    callback: ExecFileCallback,
  ) => {
    callback(null, { stdout, stderr: "" }, "");
  }) as unknown) as typeof execFile);
}

function rejectExec(error: NodeJS.ErrnoException): void {
  execFileMock.mockImplementation((((
    _cmd: string,
    _args: readonly string[],
    _opts: Record<string, unknown>,
    callback: ExecFileCallback,
  ) => {
    callback(error, "", "");
  }) as unknown) as typeof execFile);
}

describe("resolveReference", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("resolves Proton Pass references with pass-cli item view", async () => {
    resolveExec("secret-value\n");

    await expect(
      resolveReference({
        source: "protonpass",
        path: "Personal/OpenAI/password",
      }),
    ).resolves.toBe("secret-value");

    expect(execFileMock).toHaveBeenCalledWith(
      "pass-cli",
      ["item", "view", "pass://Personal/OpenAI/password"],
      expect.objectContaining({
        encoding: "utf8",
        timeout: 5000,
      }),
      expect.any(Function),
    );
  });

  it("preserves fully qualified Proton Pass reference URIs", async () => {
    resolveExec("already-qualified\n");

    await expect(
      resolveReference({
        source: "protonpass",
        path: "pass://Vault/Item/api-key",
      }),
    ).resolves.toBe("already-qualified");

    expect(execFileMock).toHaveBeenCalledWith(
      "pass-cli",
      ["item", "view", "pass://Vault/Item/api-key"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("reports missing Proton Pass CLI with install guidance", async () => {
    const error = new Error("not found") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    rejectExec(error);

    await expect(
      resolveReference({
        source: "protonpass",
        path: "Vault/Item/password",
      }),
    ).rejects.toThrow("`pass-cli` not found");
  });

  it("reports empty Proton Pass fields", async () => {
    resolveExec("\n");

    await expect(
      resolveReference({
        source: "protonpass",
        path: "Vault/Item/password",
      }),
    ).rejects.toThrow("pass://Vault/Item/password is empty");
  });
});
