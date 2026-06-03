import { describe, expect, it } from "vitest";
import {
  PasswordManagerError,
  resolveReference,
  type PasswordManagerCommandRunner,
} from "../src/password-managers.js";

describe("password-manager reference resolution", () => {
  it("resolves 1Password references through op read", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: PasswordManagerCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "sk-op\n" };
    };

    const value = await resolveReference(
      { source: "1password", path: "Personal/OpenRouter/api-key" },
      runner,
    );

    expect(value).toBe("sk-op");
    expect(calls).toEqual([
      {
        command: "op",
        args: ["read", "op://Personal/OpenRouter/api-key"],
      },
    ]);
  });

  it("resolves Proton Pass references through pass-cli item view", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: PasswordManagerCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "sk-proton\n" };
    };

    const value = await resolveReference(
      { source: "protonpass", path: "Work/GitHub/password" },
      runner,
    );

    expect(value).toBe("sk-proton");
    expect(calls).toEqual([
      {
        command: "pass-cli",
        args: ["item", "view", "pass://Work/GitHub/password"],
      },
    ]);
  });

  it("preserves an explicit Proton Pass URI", async () => {
    const runner: PasswordManagerCommandRunner = async (command, args) => {
      expect(command).toBe("pass-cli");
      expect(args).toEqual([
        "item",
        "view",
        "pass://Personal/API Keys/openrouter",
      ]);
      return { stdout: "value" };
    };

    await expect(
      resolveReference(
        { source: "protonpass", path: "pass://Personal/API Keys/openrouter" },
        runner,
      ),
    ).resolves.toBe("value");
  });

  it("rejects empty Proton Pass output", async () => {
    const runner: PasswordManagerCommandRunner = async () => ({ stdout: "\n" });

    await expect(
      resolveReference(
        { source: "protonpass", path: "Personal/Empty/password" },
        runner,
      ),
    ).rejects.toThrow(/is empty/);
  });

  it("turns missing Proton Pass CLI failures into PasswordManagerError", async () => {
    const runner: PasswordManagerCommandRunner = async () => {
      const err = new Error("spawn pass-cli ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };

    await expect(
      resolveReference(
        { source: "protonpass", path: "Personal/API/password" },
        runner,
      ),
    ).rejects.toMatchObject({
      name: "PasswordManagerError",
      source: "protonpass",
    } satisfies Partial<PasswordManagerError>);
  });

  it("explains Proton Pass authentication failures", async () => {
    const runner: PasswordManagerCommandRunner = async () => {
      throw new Error("This operation requires an authenticated client");
    };

    await expect(
      resolveReference(
        { source: "protonpass", path: "Personal/API/password" },
        runner,
      ),
    ).rejects.toThrow(/pass-cli` is not signed in/);
  });
});
