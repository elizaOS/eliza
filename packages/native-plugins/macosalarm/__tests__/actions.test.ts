import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCancelAlarmAction,
  createListAlarmsAction,
  createSetAlarmAction,
} from "../src/actions";
import type { HelperSpawn } from "../src/helper";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}

interface FakeSpawnResponder {
  (req: unknown): { stdout?: string; stderr?: string; exit?: number };
}

function makeSpawn(responder: FakeSpawnResponder): HelperSpawn {
  return () => {
    const proc = new FakeProc();
    let buf = "";
    proc.stdin.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    proc.stdin.on("finish", () => {
      const parsed = JSON.parse(buf);
      const { stdout = "", stderr = "", exit = 0 } = responder(parsed);
      if (stdout) proc.stdout.write(stdout);
      if (stderr) proc.stderr.write(stderr);
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit("close", exit));
    });
    return proc as unknown as ReturnType<HelperSpawn>;
  };
}

function fakeRuntime(): IAgentRuntime {
  return {} as unknown as IAgentRuntime;
}

function fakeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text, source: "test" },
  } as unknown as Memory;
}

async function invoke(
  action: Action,
  message: Memory,
  parameters: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult | undefined> {
  const result = await action.handler(
    fakeRuntime(),
    message,
    undefined,
    { parameters } as never,
    callback,
  );
  return result ?? undefined;
}

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

describe("macOS alarm actions", () => {
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe("on non-darwin", () => {
    beforeEach(() => setPlatform("linux"));

    it("SET_ALARM_MACOS returns macos-only without invoking spawn", async () => {
      const action = createSetAlarmAction();
      const result = await invoke(action, fakeMessage("set a mac alarm"), {
        timeIso: "2026-04-17T09:00:00Z",
        title: "Standup",
      });
      expect(result).toEqual({ success: false, error: "macos-only" });
    });

    it("LIST_ALARMS_MACOS returns macos-only", async () => {
      const action = createListAlarmsAction();
      const result = await invoke(action, fakeMessage("list"), {});
      expect(result).toEqual({ success: false, error: "macos-only" });
    });

    it("validators return false", async () => {
      const set = createSetAlarmAction();
      const cancel = createCancelAlarmAction();
      const list = createListAlarmsAction();
      expect(await set.validate(fakeRuntime(), fakeMessage("alarm"))).toBe(false);
      expect(await cancel.validate(fakeRuntime(), fakeMessage("x"))).toBe(false);
      expect(await list.validate(fakeRuntime(), fakeMessage("x"))).toBe(false);
    });
  });

  describe("on darwin (spawn mocked)", () => {
    beforeEach(() => setPlatform("darwin"));

    it("SET_ALARM_MACOS schedules via helper and returns id/fireAt", async () => {
      const spawnImpl = makeSpawn((req) => {
        const r = req as { action: string; id?: string; title?: string };
        expect(r.action).toBe("schedule");
        expect(r.title).toBe("Standup");
        return {
          stdout: `${JSON.stringify({
            success: true,
            id: r.id,
            fireAt: "2026-04-17T09:00:00Z",
          })}\n`,
        };
      });

      const action = createSetAlarmAction({
        helperOptions: { spawnImpl, binPathOverride: "/tmp/fake" },
      });

      const callback = vi.fn(async () => []);
      const result = await invoke(
        action,
        fakeMessage("set mac alarm"),
        {
          id: "alarm-42",
          timeIso: "2026-04-17T09:00:00Z",
          title: "Standup",
        },
        callback as unknown as HandlerCallback,
      );

      expect(result?.success).toBe(true);
      expect(result?.data).toEqual({
        id: "alarm-42",
        fireAt: "2026-04-17T09:00:00Z",
      });
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("SET_ALARM_MACOS rejects missing parameters", async () => {
      const action = createSetAlarmAction({
        helperOptions: {
          spawnImpl: makeSpawn(() => ({ stdout: "" })),
          binPathOverride: "/tmp/fake",
        },
      });
      const result = await invoke(action, fakeMessage("alarm"), {
        title: "only title",
      });
      expect(result?.success).toBe(false);
      expect(result?.error).toMatch(/timeIso/);
    });

    it("CANCEL_ALARM_MACOS forwards id to helper", async () => {
      const spawnImpl = makeSpawn((req) => {
        const r = req as { action: string; id?: string };
        expect(r.action).toBe("cancel");
        expect(r.id).toBe("alarm-42");
        return {
          stdout: `${JSON.stringify({
            success: true,
            id: "alarm-42",
            cancelled: true,
          })}\n`,
        };
      });
      const action = createCancelAlarmAction({
        helperOptions: { spawnImpl, binPathOverride: "/tmp/fake" },
      });
      const result = await invoke(action, fakeMessage("cancel"), {
        id: "alarm-42",
      });
      expect(result?.success).toBe(true);
    });

    it("LIST_ALARMS_MACOS returns parsed alarm list", async () => {
      const spawnImpl = makeSpawn(() => ({
        stdout: `${JSON.stringify({
          success: true,
          alarms: [
            { id: "a", title: "T", body: "", fireAt: "2026-04-17T09:00:00Z" },
          ],
        })}\n`,
      }));
      const action = createListAlarmsAction({
        helperOptions: { spawnImpl, binPathOverride: "/tmp/fake" },
      });
      const result = await invoke(action, fakeMessage("list"), {});
      expect(result?.success).toBe(true);
      const data = result?.data as { alarms: Array<{ id: string }> };
      expect(data.alarms).toHaveLength(1);
      expect(data.alarms[0]?.id).toBe("a");
    });
  });
});
