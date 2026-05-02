import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runHelper } from "../src/helper";
import type { HelperSpawn } from "../src/helper";
import type {
  MacosAlarmHelperRequest,
  MacosAlarmHelperResponse,
} from "../src/types";

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}

function makeSpawn(responder: (req: MacosAlarmHelperRequest) => {
  stdout?: string;
  stderr?: string;
  exit?: number;
}): HelperSpawn {
  return () => {
    const proc = new FakeProc();
    // Read the request written to stdin, then emit the response.
    let buf = "";
    proc.stdin.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    proc.stdin.on("finish", () => {
      const parsed = JSON.parse(buf) as MacosAlarmHelperRequest;
      const { stdout = "", stderr = "", exit = 0 } = responder(parsed);
      if (stdout) proc.stdout.write(stdout);
      if (stderr) proc.stderr.write(stderr);
      proc.stdout.end();
      proc.stderr.end();
      // Emit close on next tick so listeners attach first.
      setImmediate(() => proc.emit("close", exit));
    });
    return proc as unknown as ReturnType<HelperSpawn>;
  };
}

describe("runHelper", () => {
  it("parses a schedule success response", async () => {
    const spawnImpl = makeSpawn((req) => {
      expect(req.action).toBe("schedule");
      expect(req.id).toBe("alarm-1");
      const resp: MacosAlarmHelperResponse = {
        success: true,
        id: "alarm-1",
        fireAt: "2026-04-17T09:00:00Z",
      };
      return { stdout: `${JSON.stringify(resp)}\n` };
    });

    const out = await runHelper(
      {
        action: "schedule",
        id: "alarm-1",
        timeIso: "2026-04-17T09:00:00Z",
        title: "Standup",
      },
      { spawnImpl, binPathOverride: "/tmp/fake-bin" },
    );

    expect(out).toEqual({
      success: true,
      id: "alarm-1",
      fireAt: "2026-04-17T09:00:00Z",
    });
  });

  it("returns helper error payload without throwing", async () => {
    const spawnImpl = makeSpawn(() => ({
      stdout: `${JSON.stringify({ success: false, error: "permission-denied: user declined" })}\n`,
      exit: 3,
    }));

    const out = await runHelper(
      { action: "list" },
      { spawnImpl, binPathOverride: "/tmp/fake-bin" },
    );

    expect(out).toEqual({
      success: false,
      error: "permission-denied: user declined",
    });
  });

  it("throws when stdout is empty", async () => {
    const spawnImpl = makeSpawn(() => ({ stdout: "", exit: 1 }));
    await expect(
      runHelper(
        { action: "list" },
        { spawnImpl, binPathOverride: "/tmp/fake-bin" },
      ),
    ).rejects.toThrow(/no stdout/);
  });
});
