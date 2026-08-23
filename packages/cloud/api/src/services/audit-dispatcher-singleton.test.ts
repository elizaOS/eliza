/**
 * Behavioural coverage for the process-global AuditDispatcher singleton:
 * lazy init, identity, replacement, custom versus default sinks, empty and
 * single-sink fan-out, and the AUDIT_LOG_SINK LoggerSink branch. There is no
 * queue, capacity, or comparator — empty sinks, one sink, and swapping a
 * prior instance are the corresponding edges. The suite drives the real
 * module. Root Vitest does not load this package's tsconfig path aliases, so
 * `@/api-app/services/audit` is remapped to the real audit barrel and the
 * logger/db imports are load-time stubs — assertions cover the singleton,
 * not those stubs.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { AuditDispatcher, type AuditSink, LoggerSink } from "./audit/index.js";
import { InMemorySink } from "./audit/testing.js";
import {
  getAuditDispatcher,
  initAuditDispatcher,
  setAuditDispatcher,
} from "./audit-dispatcher-singleton.js";
import { auditEventsSink } from "./audit-events.js";

vi.mock(
  "@/api-app/services/audit",
  async () => await import("./audit/index.js"),
);
vi.mock("@/lib/utils/logger", () => ({
  logger: {
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
  },
}));
vi.mock("@/db/client", () => ({
  dbWrite: {
    insert: () => ({
      values: async () => undefined,
    }),
  },
}));
vi.mock(
  "@/db/schemas/auth-events",
  async () => await import("../../../shared/src/db/schemas/auth-events.ts"),
);

const originalAuditLogSink = process.env.AUDIT_LOG_SINK;

afterEach(() => {
  if (originalAuditLogSink === undefined) {
    delete process.env.AUDIT_LOG_SINK;
  } else {
    process.env.AUDIT_LOG_SINK = originalAuditLogSink;
  }
});

function installedSinks(dispatcher: AuditDispatcher): AuditSink[] {
  return Reflect.get(dispatcher, "sinks") as AuditSink[];
}

function loginInput() {
  return {
    actor: { type: "user" as const, id: "u_singleton" },
    action: "auth.login",
    result: "success" as const,
  };
}

describe("audit-dispatcher-singleton", () => {
  test("initAuditDispatcher with no sinks argument installs the auth_events sink", () => {
    delete process.env.AUDIT_LOG_SINK;
    const dispatcher = initAuditDispatcher();
    const sinks = installedSinks(dispatcher);
    expect(dispatcher).toBeInstanceOf(AuditDispatcher);
    expect(sinks).toEqual([auditEventsSink]);
    expect(getAuditDispatcher()).toBe(dispatcher);
  });

  test("initAuditDispatcher adds LoggerSink only when AUDIT_LOG_SINK is exactly true", () => {
    process.env.AUDIT_LOG_SINK = "true";
    const withLogger = initAuditDispatcher();
    const withLoggerSinks = installedSinks(withLogger);
    expect(withLoggerSinks).toHaveLength(2);
    expect(withLoggerSinks[0]).toBe(auditEventsSink);
    expect(withLoggerSinks[1]).toBeInstanceOf(LoggerSink);
    expect(withLoggerSinks[1]?.name).toBe("logger");

    process.env.AUDIT_LOG_SINK = "TRUE";
    expect(installedSinks(initAuditDispatcher())).toEqual([auditEventsSink]);

    process.env.AUDIT_LOG_SINK = "false";
    expect(installedSinks(initAuditDispatcher())).toEqual([auditEventsSink]);

    process.env.AUDIT_LOG_SINK = "";
    expect(installedSinks(initAuditDispatcher())).toEqual([auditEventsSink]);
  });

  test("initAuditDispatcher with an empty sinks array does not install defaults", async () => {
    const dispatcher = initAuditDispatcher([]);
    expect(installedSinks(dispatcher)).toEqual([]);
    const event = await dispatcher.emit(loginInput());
    expect(event.action).toBe("auth.login");
    expect(event.actor.id).toBe("u_singleton");
    expect(getAuditDispatcher()).toBe(dispatcher);
  });

  test("initAuditDispatcher with one sink fans out only to that sink", async () => {
    const memory = new InMemorySink();
    const dispatcher = initAuditDispatcher([memory]);
    expect(installedSinks(dispatcher)).toEqual([memory]);
    await dispatcher.emit(loginInput());
    expect(memory.snapshot()).toHaveLength(1);
    expect(memory.snapshot()[0]?.action).toBe("auth.login");
  });

  test("initAuditDispatcher with several sinks fans out to each of them", async () => {
    const first = new InMemorySink();
    const second = new InMemorySink();
    initAuditDispatcher([first, second]);
    await getAuditDispatcher().emit(loginInput());
    expect(first.snapshot()).toHaveLength(1);
    expect(second.snapshot()).toHaveLength(1);
    expect(first.snapshot()[0]?.event_id).toBe(second.snapshot()[0]?.event_id);
  });

  test("initAuditDispatcher replaces the previous process-global instance", () => {
    const first = initAuditDispatcher([new InMemorySink()]);
    const second = initAuditDispatcher([new InMemorySink()]);
    expect(second).not.toBe(first);
    expect(getAuditDispatcher()).toBe(second);
    expect(getAuditDispatcher()).not.toBe(first);
  });

  test("setAuditDispatcher makes getAuditDispatcher return that instance", async () => {
    const memory = new InMemorySink();
    const replacement = new AuditDispatcher({ sinks: [memory] });
    setAuditDispatcher(replacement);
    expect(getAuditDispatcher()).toBe(replacement);
    await getAuditDispatcher().emit(loginInput());
    expect(memory.snapshot()).toHaveLength(1);
    expect(memory.snapshot()[0]?.result).toBe("success");
  });

  test("getAuditDispatcher returns the same instance on repeated calls", () => {
    const dispatcher = initAuditDispatcher([new InMemorySink()]);
    expect(getAuditDispatcher()).toBe(dispatcher);
    expect(getAuditDispatcher()).toBe(getAuditDispatcher());
  });

  test("getAuditDispatcher lazily constructs the default dispatcher once", async () => {
    delete process.env.AUDIT_LOG_SINK;
    vi.resetModules();
    const mod = await import("./audit-dispatcher-singleton.js");
    const first = mod.getAuditDispatcher();
    const second = mod.getAuditDispatcher();
    expect(first).toBe(second);
    expect(installedSinks(first)).toHaveLength(1);
    expect(installedSinks(first)[0]?.name).toBe("auth_events_pg");
  });

  test("the returned dispatcher is a live AuditDispatcher that accepts addSink", async () => {
    const first = new InMemorySink();
    const extra = new InMemorySink();
    const dispatcher = initAuditDispatcher([first]);
    dispatcher.addSink(extra);
    await dispatcher.emit(loginInput());
    expect(first.snapshot()).toHaveLength(1);
    expect(extra.snapshot()).toHaveLength(1);
  });

  test("initAuditDispatcher wires a required-sink failure through emit", async () => {
    const failing: AuditSink = {
      name: "failing",
      emit: async () => {
        throw new Error("boom");
      },
    };
    const dispatcher = initAuditDispatcher([failing]);
    await expect(dispatcher.emit(loginInput())).rejects.toThrow(
      "Required audit sink delivery failed: failing",
    );
  });
});
