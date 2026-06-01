import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseApprovalManager } from "../approval-manager.js";
import { sanitizeChildEnv, validateFilePath } from "../platform/security.js";

describe("validateFilePath credential blocklist (cross-home)", () => {
  it("blocks SSH keys under any user's home, not just the current home", () => {
    expect(validateFilePath("/root/.ssh/id_rsa", "read").allowed).toBe(false);
    expect(
      validateFilePath("/home/otheruser/.ssh/id_rsa", "read").allowed,
    ).toBe(false);
    expect(
      validateFilePath("/home/otheruser/.aws/credentials", "read").allowed,
    ).toBe(false);
  });

  it("blocks credential files under the current home for reads", () => {
    const home = os.homedir().replace(/\\/g, "/");
    expect(validateFilePath(`${home}/.aws/credentials`, "read").allowed).toBe(
      false,
    );
    expect(validateFilePath(`${home}/.netrc`, "read").allowed).toBe(false);
  });

  it("allows benign files in a home directory", () => {
    expect(validateFilePath("/home/otheruser/notes.txt", "read").allowed).toBe(
      true,
    );
  });
});

describe("validateFilePath system-dir read protection (unix)", () => {
  const original = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: original });
  });

  it("blocks reads of /etc/shadow and other auth config", () => {
    const result = validateFilePath("/etc/shadow", "read");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/system auth config/i);
  });

  it("blocks reads of /proc, /sys, and /dev", () => {
    expect(validateFilePath("/proc/1/environ", "read").allowed).toBe(false);
    expect(validateFilePath("/sys/kernel/notes", "read").allowed).toBe(false);
    expect(validateFilePath("/dev/sda", "read").allowed).toBe(false);
  });

  it("still allows reads outside system dirs", () => {
    expect(validateFilePath("/tmp/output.txt", "read").allowed).toBe(true);
  });
});

describe("sanitizeChildEnv provider-key stripping", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "DISCORD_API_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "ELIZA_SECRET_KEY",
    "SOME_HARMLESS_VALUE",
  ];

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
    }
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    process.env.GROQ_API_KEY = "gsk-test";
    process.env.XAI_API_KEY = "xai-test";
    process.env.DISCORD_API_TOKEN = "discord-test";
    process.env.TELEGRAM_BOT_TOKEN = "tg-test";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-test";
    process.env.ELIZA_SECRET_KEY = "eliza-test";
    process.env.SOME_HARMLESS_VALUE = "keep-me";
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("strips provider/connector API keys from the child env", () => {
    const env = sanitizeChildEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.DISCORD_API_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.ELIZA_SECRET_KEY).toBeUndefined();
  });

  it("keeps harmless env values", () => {
    const env = sanitizeChildEnv();
    expect(env.SOME_HARMLESS_VALUE).toBe("keep-me");
  });
});

describe("ComputerUseApprovalManager default mode", () => {
  it("defaults to smart_approve and requires approval for destructive verbs", () => {
    // Force loadConfig to keep the default by failing the file read.
    vi.spyOn(
      ComputerUseApprovalManager.prototype as unknown as {
        loadConfig: () => void;
      },
      "loadConfig",
    ).mockImplementation(() => {});
    const manager = new ComputerUseApprovalManager();
    expect(manager.getMode()).toBe("smart_approve");
    // Read-only safe command auto-approves.
    expect(manager.shouldAutoApprove("screenshot")).toBe(true);
    expect(manager.shouldAutoApprove("file_read")).toBe(true);
    // Destructive verbs are NOT auto-approved by default.
    expect(manager.shouldAutoApprove("execute_command")).toBe(false);
    expect(manager.shouldAutoApprove("file_delete")).toBe(false);
    expect(manager.shouldAutoApprove("file_write")).toBe(false);
    vi.restoreAllMocks();
  });
});
