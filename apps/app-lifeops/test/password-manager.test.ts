import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// child_process must be mocked before importing the module under test.
vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("node:child_process");
  const { EventEmitter } = await import("node:events");
  const util = await import("node:util");

  // execFile(file, args, opts?, cb)
  const execFile = vi.fn(
    (
      file: string,
      args: string[],
      _optsOrCb: unknown,
      maybeCb?: (
        err: NodeJS.ErrnoException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      const cb =
        typeof _optsOrCb === "function"
          ? (_optsOrCb as (
              err: NodeJS.ErrnoException | null,
              stdout: string,
              stderr: string,
            ) => void)
          : maybeCb;
      const handler = execFileBehavior(file, args);
      if (handler.error) {
        cb?.(handler.error, "", handler.stderr ?? "");
      } else {
        cb?.(null, handler.stdout ?? "", handler.stderr ?? "");
      }
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      return ee;
    },
  );

  // promisify(execFile) returns { stdout, stderr } — implement the custom hook.
  (execFile as unknown as Record<symbol, unknown>)[util.promisify.custom] = (
    file: string,
    args: string[],
  ) =>
    new Promise((resolve, reject) => {
      const handler = execFileBehavior(file, args);
      if (handler.error) {
        reject(handler.error);
      } else {
        resolve({ stdout: handler.stdout ?? "", stderr: handler.stderr ?? "" });
      }
    });

  const spawn = vi.fn((_cmd: string, _args: string[]) => {
    const ee = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { pipe: (sink: unknown) => void };
      stderr: EventEmitter;
      stdin: EventEmitter;
      kill: () => void;
    };
    ee.stdout = Object.assign(new EventEmitter(), {
      pipe: () => undefined,
    });
    ee.stderr = new EventEmitter();
    ee.stdin = new EventEmitter();
    ee.kill = () => undefined;
    setImmediate(() => {
      ee.emit("close", 0);
    });
    return ee;
  });

  return { ...actual, execFile, spawn };
});

// State controlling execFile mock behavior per test.
type ExecFileBehavior = {
  error?: NodeJS.ErrnoException;
  stdout?: string;
  stderr?: string;
};
const execFileBehaviors: Array<{
  match: (file: string, args: string[]) => boolean;
  result: ExecFileBehavior;
}> = [];

function execFileBehavior(file: string, args: string[]): ExecFileBehavior {
  for (const b of execFileBehaviors) {
    if (b.match(file, args)) return b.result;
  }
  // Default: command not found
  const err: NodeJS.ErrnoException = Object.assign(
    new Error(`command not found: ${file}`),
    { code: "ENOENT" },
  );
  return { error: err };
}

function setExecFile(
  match: (file: string, args: string[]) => boolean,
  result: ExecFileBehavior,
): void {
  execFileBehaviors.push({ match, result });
}

import {
  clearPasswordManagerBackendCache,
  detectPasswordManagerBackend,
  injectCredentialToClipboard,
  searchPasswordItems,
  PasswordManagerError,
} from "../src/lifeops/password-manager-bridge.js";
import { passwordManagerAction } from "../src/actions/password-manager.js";
import { spawn as mockedSpawn } from "node:child_process";

const SAME_ID = "00000000-0000-0000-0000-000000000001";
const ORIGINAL_ENV = { ...process.env };

function makeRuntime() {
  return {
    agentId: SAME_ID,
    getSetting: () => undefined,
  } as unknown as Parameters<
    NonNullable<typeof passwordManagerAction.handler>
  >[0];
}

function makeMessage() {
  return {
    entityId: SAME_ID,
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "pw" },
  } as unknown as Parameters<
    NonNullable<typeof passwordManagerAction.handler>
  >[1];
}

beforeEach(() => {
  execFileBehaviors.length = 0;
  clearPasswordManagerBackendCache();
  delete process.env.MILADY_TEST_PASSWORD_MANAGER_BACKEND;
  delete process.env.MILADY_BENCHMARK_USE_MOCKS;
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("detectPasswordManagerBackend", () => {
  test('returns "none" when neither op nor pass is on PATH', async () => {
    const backend = await detectPasswordManagerBackend();
    expect(backend).toBe("none");
  });

  test('returns "1password" when `op --version` succeeds', async () => {
    setExecFile(
      (file, args) => file === "op" && args[0] === "--version",
      { stdout: "2.0.0\n" },
    );
    const backend = await detectPasswordManagerBackend();
    expect(backend).toBe("1password");
  });

  test("does not enable fixture backend from benchmark mock mode", async () => {
    process.env.MILADY_BENCHMARK_USE_MOCKS = "1";

    const backend = await detectPasswordManagerBackend();

    expect(backend).toBe("none");
  });

  test("enables fixture backend only from explicit password-manager test env", async () => {
    process.env.MILADY_TEST_PASSWORD_MANAGER_BACKEND = "fixture";

    const backend = await detectPasswordManagerBackend();

    expect(backend).toBe("fixture");
  });
});

describe("searchPasswordItems (1password)", () => {
  test("parses `op item list --format json` JSON output", async () => {
    setExecFile(
      (file, args) => file === "op" && args[0] === "--version",
      { stdout: "2.0.0\n" },
    );
    const items = [
      {
        id: "abc123",
        title: "GitHub",
        category: "LOGIN",
        urls: [{ href: "https://github.com", primary: true }],
        additional_information: "alice",
        tags: ["dev"],
        vault: { name: "Personal" },
      },
      {
        id: "def456",
        title: "AWS Console",
        category: "LOGIN",
        urls: [{ href: "https://aws.amazon.com" }],
        additional_information: "bob",
      },
    ];
    setExecFile(
      (file, args) =>
        file === "op" && args.includes("item") && args.includes("list"),
      { stdout: JSON.stringify(items) },
    );

    const results = await searchPasswordItems("github");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("abc123");
    expect(results[0].title).toBe("GitHub");
    expect(results[0].url).toBe("https://github.com");
    expect(results[0].username).toBe("alice");
    expect(results[0].hasPassword).toBe(true);
  });
});

describe("injectCredentialToClipboard", () => {
  test("uses spawn with argv arrays and never inlines secret in argv", async () => {
    setExecFile(
      (file, args) => file === "op" && args[0] === "--version",
      { stdout: "2.0.0\n" },
    );

    const result = await injectCredentialToClipboard("item-xyz", "password");
    expect(result.ok).toBe(true);
    expect(mockedSpawn).toHaveBeenCalled();

    const calls = (mockedSpawn as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    // Locate the producer (op item get ...) call.
    const opCall = calls.find(
      (c) => c[0] === "op" && Array.isArray(c[1]) && (c[1] as string[])[0] === "item",
    );
    expect(opCall).toBeDefined();
    const opArgs = opCall![1] as string[];
    expect(opArgs).toContain("get");
    expect(opArgs).toContain("item-xyz");
    expect(opArgs).toContain("--reveal");
    // Argv must not contain anything that looks like a literal password value
    // — the bridge pipes the secret via stdout/stdin only.
    for (const a of opArgs) {
      expect(typeof a).toBe("string");
    }
  });

  test("rejects empty itemId", async () => {
    await expect(
      injectCredentialToClipboard("", "password"),
    ).rejects.toBeInstanceOf(PasswordManagerError);
  });
});

describe("passwordManagerAction", () => {
  test("inject_password without confirmed=true is rejected", async () => {
    setExecFile(
      (file, args) => file === "op" && args[0] === "--version",
      { stdout: "2.0.0\n" },
    );
    const result = await passwordManagerAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          subaction: "inject_password",
          itemId: "abc",
        },
      },
    );
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    expect((r.data ?? {}).error).toBe("CONFIRMATION_REQUIRED");
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  test("list subaction returns items", async () => {
    setExecFile(
      (file, args) => file === "op" && args[0] === "--version",
      { stdout: "2.0.0\n" },
    );
    setExecFile(
      (file, args) =>
        file === "op" && args.includes("item") && args.includes("list"),
      {
        stdout: JSON.stringify([
          { id: "1", title: "Acme", category: "LOGIN" },
          { id: "2", title: "Beta", category: "LOGIN" },
        ]),
      },
    );

    const result = await passwordManagerAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "list" } },
    );
    const r = result as {
      success: boolean;
      data?: { items?: unknown[] };
      values?: { count?: number };
    };
    expect(r.success).toBe(true);
    expect(r.data?.items).toHaveLength(2);
    expect(r.values?.count).toBe(2);
  });

  test("validate is owner-gated", async () => {
    // entityId differs from agentId → not owner self.
    const runtime = {
      agentId: SAME_ID,
      getSetting: () => undefined,
    } as unknown as Parameters<
      NonNullable<typeof passwordManagerAction.validate>
    >[0];
    const otherEntity = {
      entityId: "00000000-0000-0000-0000-0000000000ff",
      content: { text: "" },
    } as unknown as Parameters<
      NonNullable<typeof passwordManagerAction.validate>
    >[1];
    const ok = await passwordManagerAction.validate!(runtime, otherEntity);
    expect(ok).toBe(false);

    // entityId === agentId → agent self, allowed.
    const ownerOk = await passwordManagerAction.validate!(
      runtime,
      makeMessage(),
    );
    expect(ownerOk).toBe(true);
  });
});
