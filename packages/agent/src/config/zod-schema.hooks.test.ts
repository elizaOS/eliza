/**
 * Zod schema contract for the workspace hooks config surface. Every exported
 * schema is exercised through safeParse: optional roots, empty queues, single
 * elements, required-field absence, strict extra keys, union literals, and
 * positive-int overflow. Deterministic; no live services.
 */
import { describe, expect, it } from "vitest";
import {
  HookMappingSchema,
  HooksGmailSchema,
  InstallRecordSchema,
  InternalHookHandlerSchema,
  InternalHooksSchema,
} from "./zod-schema.hooks.ts";

type ParseSchema = {
  safeParse: (value: unknown) => { success: boolean; data?: unknown };
};

function expectOk(schema: ParseSchema, value: unknown, data: unknown = value) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
  if (result.success) expect(result.data).toEqual(data);
}

function expectFail(schema: ParseSchema, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

const HOOK_CHANNELS = [
  "last",
  "whatsapp",
  "telegram",
  "discord",
  "googlechat",
  "slack",
  "imessage",
  "msteams",
] as const;

describe("HookMappingSchema", () => {
  it("accepts undefined and an empty object because the root is optional", () => {
    expectOk(HookMappingSchema, undefined, undefined);
    expectOk(HookMappingSchema, {});
  });

  it("round-trips a fully populated valid mapping", () => {
    const mapping = {
      id: "wake-inbox",
      match: { path: "/hooks/inbox", source: "gmail" },
      action: "wake" as const,
      wakeMode: "now" as const,
      name: "inbox",
      sessionKey: "owner",
      messageTemplate: "new mail: {{subject}}",
      textTemplate: "{{snippet}}",
      deliver: true,
      allowUnsafeExternalContent: false,
      channel: "telegram" as const,
      to: "owner",
      model: "gpt-5",
      thinking: "low",
      timeoutSeconds: 30,
      transform: { module: "./transform.js", export: "run" },
    };
    expectOk(HookMappingSchema, mapping);
  });

  it("rejects a non-object root", () => {
    expectFail(HookMappingSchema, null);
    expectFail(HookMappingSchema, "wake");
    expectFail(HookMappingSchema, 1);
    expectFail(HookMappingSchema, []);
  });

  it("rejects unknown top-level keys (strict)", () => {
    expectFail(HookMappingSchema, { extra: true });
    expectFail(HookMappingSchema, { action: "wake", plugins: [] });
  });

  it("accepts an empty match object and optional path/source strings", () => {
    expectOk(HookMappingSchema, { match: {} });
    expectOk(HookMappingSchema, { match: { path: "/hooks" } });
    expectOk(HookMappingSchema, { match: { source: "gmail" } });
    expectOk(HookMappingSchema, { match: { path: "", source: "" } });
  });

  it("strips unknown keys on match because that inner object is not strict", () => {
    expectOk(
      HookMappingSchema,
      { match: { path: "/hooks", extra: true } },
      { match: { path: "/hooks" } },
    );
  });

  it("rejects a non-object match and non-string match fields", () => {
    expectFail(HookMappingSchema, { match: null });
    expectFail(HookMappingSchema, { match: "gmail" });
    expectFail(HookMappingSchema, { match: { path: 1 } });
    expectFail(HookMappingSchema, { match: { source: true } });
  });

  it("accepts both action literals and both wakeMode literals", () => {
    expectOk(HookMappingSchema, { action: "wake" });
    expectOk(HookMappingSchema, { action: "agent" });
    expectOk(HookMappingSchema, { wakeMode: "now" });
    expectOk(HookMappingSchema, { wakeMode: "next-heartbeat" });
  });

  it("rejects unknown action and wakeMode values", () => {
    expectFail(HookMappingSchema, { action: "sleep" });
    expectFail(HookMappingSchema, { action: "" });
    expectFail(HookMappingSchema, { wakeMode: "later" });
    expectFail(HookMappingSchema, { wakeMode: "now-heartbeat" });
  });

  it("accepts every documented delivery channel and rejects an unknown one", () => {
    for (const channel of HOOK_CHANNELS) {
      expectOk(HookMappingSchema, { channel });
    }
    expectFail(HookMappingSchema, { channel: "signal" });
    expectFail(HookMappingSchema, { channel: "email" });
    expectFail(HookMappingSchema, { channel: "" });
  });

  it("accepts boolean deliver/allowUnsafeExternalContent and rejects non-booleans", () => {
    expectOk(HookMappingSchema, {
      deliver: true,
      allowUnsafeExternalContent: false,
    });
    expectFail(HookMappingSchema, { deliver: "true" });
    expectFail(HookMappingSchema, { allowUnsafeExternalContent: 1 });
  });

  it("accepts a positive integer timeoutSeconds and rejects zero, negative, and overflow floats", () => {
    expectOk(HookMappingSchema, { timeoutSeconds: 1 });
    expectFail(HookMappingSchema, { timeoutSeconds: 0 });
    expectFail(HookMappingSchema, { timeoutSeconds: -1 });
    expectFail(HookMappingSchema, { timeoutSeconds: 1.5 });
    expectFail(HookMappingSchema, { timeoutSeconds: Number.POSITIVE_INFINITY });
  });

  it("requires transform.module, accepts optional export, and rejects extra transform keys", () => {
    expectOk(HookMappingSchema, { transform: { module: "./t.js" } });
    expectOk(HookMappingSchema, {
      transform: { module: "./t.js", export: "run" },
    });
    expectFail(HookMappingSchema, { transform: {} });
    expectFail(HookMappingSchema, { transform: { export: "run" } });
    expectFail(HookMappingSchema, {
      transform: { module: "./t.js", extra: true },
    });
    expectFail(HookMappingSchema, { transform: { module: 1 } });
  });
});

describe("InternalHookHandlerSchema", () => {
  it("requires event and module and accepts an optional export", () => {
    expectOk(InternalHookHandlerSchema, { event: "message", module: "./h.js" });
    expectOk(InternalHookHandlerSchema, {
      event: "message",
      module: "./h.js",
      export: "handle",
    });
  });

  it("rejects a missing required field, empty object, and undefined root", () => {
    expectFail(InternalHookHandlerSchema, undefined);
    expectFail(InternalHookHandlerSchema, {});
    expectFail(InternalHookHandlerSchema, { event: "message" });
    expectFail(InternalHookHandlerSchema, { module: "./h.js" });
  });

  it("rejects extra keys (strict) and non-string fields", () => {
    expectFail(InternalHookHandlerSchema, {
      event: "message",
      module: "./h.js",
      extra: true,
    });
    expectFail(InternalHookHandlerSchema, { event: 1, module: "./h.js" });
    expectFail(InternalHookHandlerSchema, { event: "message", module: 1 });
    expectFail(InternalHookHandlerSchema, null);
    expectFail(InternalHookHandlerSchema, []);
  });
});

describe("InstallRecordSchema", () => {
  it("accepts each source literal with only the required field", () => {
    expectOk(InstallRecordSchema, { source: "npm" });
    expectOk(InstallRecordSchema, { source: "archive" });
    expectOk(InstallRecordSchema, { source: "path" });
  });

  it("round-trips a fully populated install record", () => {
    expectOk(InstallRecordSchema, {
      source: "npm",
      spec: "@scope/hook@1.0.0",
      sourcePath: "./vendor/hook.tgz",
      installPath: "./hooks/hook",
      version: "1.0.0",
      installedAt: "2026-08-23T00:00:00.000Z",
      hooks: ["on-mail"],
    });
  });

  it("accepts an empty hooks queue and a single hook name", () => {
    expectOk(InstallRecordSchema, { source: "path", hooks: [] });
    expectOk(InstallRecordSchema, { source: "path", hooks: ["on-mail"] });
  });

  it("rejects a missing or unknown source", () => {
    expectFail(InstallRecordSchema, {});
    expectFail(InstallRecordSchema, { source: "git" });
    expectFail(InstallRecordSchema, { source: "" });
    expectFail(InstallRecordSchema, undefined);
  });

  it("rejects extra keys, a non-string hooks item, and a non-array hooks field", () => {
    expectFail(InstallRecordSchema, { source: "npm", extra: true });
    expectFail(InstallRecordSchema, { source: "npm", hooks: [1] });
    expectFail(InstallRecordSchema, { source: "npm", hooks: "on-mail" });
  });
});

describe("InternalHooksSchema", () => {
  it("accepts undefined and an empty object because the root is optional", () => {
    expectOk(InternalHooksSchema, undefined, undefined);
    expectOk(InternalHooksSchema, {});
  });

  it("accepts an empty handlers queue and a single valid handler", () => {
    expectOk(InternalHooksSchema, { handlers: [] });
    expectOk(InternalHooksSchema, {
      handlers: [{ event: "message", module: "./h.js" }],
    });
  });

  it("rejects a handler missing a required field", () => {
    expectFail(InternalHooksSchema, { handlers: [{ event: "message" }] });
    expectFail(InternalHooksSchema, { handlers: [{ module: "./h.js" }] });
  });

  it("accepts empty and populated entries, including empty env records", () => {
    expectOk(InternalHooksSchema, { entries: {} });
    expectOk(InternalHooksSchema, {
      entries: { mail: { enabled: true, env: {} } },
    });
    expectOk(InternalHooksSchema, {
      entries: { mail: { enabled: false, env: { TOKEN: "x" } } },
    });
  });

  it("rejects extra keys on an entry and non-string env values", () => {
    expectFail(InternalHooksSchema, {
      entries: { mail: { enabled: true, extra: true } },
    });
    expectFail(InternalHooksSchema, {
      entries: { mail: { env: { TOKEN: 1 } } },
    });
  });

  it("accepts load.extraDirs as an empty queue or a single path", () => {
    expectOk(InternalHooksSchema, { load: {} });
    expectOk(InternalHooksSchema, { load: { extraDirs: [] } });
    expectOk(InternalHooksSchema, { load: { extraDirs: ["./hooks"] } });
  });

  it("rejects extra load keys and a non-string extraDirs item", () => {
    expectFail(InternalHooksSchema, { load: { extra: true } });
    expectFail(InternalHooksSchema, { load: { extraDirs: [1] } });
  });

  it("accepts empty installs, a single valid record, and rejects a missing source", () => {
    expectOk(InternalHooksSchema, { installs: {} });
    expectOk(InternalHooksSchema, {
      installs: { mail: { source: "npm", spec: "@scope/hook" } },
    });
    expectFail(InternalHooksSchema, { installs: { mail: {} } });
    expectFail(InternalHooksSchema, { installs: { mail: { source: "git" } } });
  });

  it("rejects unknown top-level keys and a non-object root", () => {
    expectFail(InternalHooksSchema, { extra: true });
    expectFail(InternalHooksSchema, null);
    expectFail(InternalHooksSchema, []);
  });
});

describe("HooksGmailSchema", () => {
  it("accepts undefined and an empty object because the root is optional", () => {
    expectOk(HooksGmailSchema, undefined, undefined);
    expectOk(HooksGmailSchema, {});
  });

  it("round-trips a fully populated gmail hook config", () => {
    expectOk(HooksGmailSchema, {
      account: "owner@example.com",
      label: "INBOX",
      topic: "projects/x/topics/mail",
      subscription: "projects/x/subscriptions/mail",
      pushToken: "token",
      hookUrl: "https://example.invalid/hooks/gmail",
      includeBody: true,
      maxBytes: 1024,
      renewEveryMinutes: 30,
      allowUnsafeExternalContent: false,
      serve: { bind: "127.0.0.1", port: 8787, path: "/gmail" },
      tailscale: {
        mode: "funnel",
        path: "/gmail",
        target: "http://127.0.0.1:8787",
      },
      model: "gpt-5",
      thinking: "low",
    });
  });

  it("accepts every thinking literal and every tailscale mode", () => {
    for (const thinking of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ] as const) {
      expectOk(HooksGmailSchema, { thinking });
    }
    for (const mode of ["off", "serve", "funnel"] as const) {
      expectOk(HooksGmailSchema, { tailscale: { mode } });
    }
  });

  it("rejects unknown thinking and tailscale mode values", () => {
    expectFail(HooksGmailSchema, { thinking: "max" });
    expectFail(HooksGmailSchema, { thinking: "" });
    expectFail(HooksGmailSchema, { tailscale: { mode: "on" } });
  });

  it("accepts positive integer maxBytes, renewEveryMinutes, and serve.port; rejects zero and overflow floats", () => {
    expectOk(HooksGmailSchema, { maxBytes: 1, renewEveryMinutes: 1 });
    expectOk(HooksGmailSchema, { serve: { port: 1 } });
    expectFail(HooksGmailSchema, { maxBytes: 0 });
    expectFail(HooksGmailSchema, { renewEveryMinutes: -1 });
    expectFail(HooksGmailSchema, { maxBytes: 1.5 });
    expectFail(HooksGmailSchema, { serve: { port: 0 } });
    expectFail(HooksGmailSchema, { serve: { port: 8080.5 } });
  });

  it("rejects extra keys on the root, serve, and tailscale objects", () => {
    expectFail(HooksGmailSchema, { extra: true });
    expectFail(HooksGmailSchema, { serve: { bind: "127.0.0.1", extra: true } });
    expectFail(HooksGmailSchema, { tailscale: { mode: "off", extra: true } });
  });

  it("rejects a non-object root and non-boolean includeBody", () => {
    expectFail(HooksGmailSchema, null);
    expectFail(HooksGmailSchema, []);
    expectFail(HooksGmailSchema, { includeBody: "true" });
  });
});
