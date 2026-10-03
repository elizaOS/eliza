/**
 * LOGS delete and RUNTIME reload_config must fail closed when a 2xx response
 * does not carry the route's acknowledgement. A proxy HTML page, an empty
 * object, or a malformed count previously reported "Cleared 0 log entries." or
 * "No hot-reloadable fields changed." although nothing was confirmed.
 * Deterministic; stubs global fetch and calls the real action handlers.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logsAction } from "./logs.ts";
import { runtimeAction } from "./runtime.ts";

function respond(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": body.startsWith("<") ? "text/html" : "application/json",
    },
  });
}

function run(
  action: typeof logsAction | typeof runtimeAction,
  op: string,
): ReturnType<typeof logsAction.handler> {
  return action.handler(
    {} as IAgentRuntime,
    { roomId: "room" } as unknown as Memory,
    undefined,
    { parameters: { action: op } },
    undefined,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LOGS delete acknowledgement", () => {
  it.each([
    "<html>proxy</html>",
    "{}",
    "[]",
    "null",
    '{"cleared":"lots"}',
    '{"cleared":-1}',
    '{"cleared":1.5}',
  ])(
    "fails when a 2xx body does not report a cleared count: %s",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond(body)),
      );

      const result = await run(logsAction, "delete");

      expect(result?.success).toBe(false);
      expect(result?.values).toMatchObject({ error: "LOGS_DELETE_FAILED" });
      expect(result?.text).toContain("did not confirm the clear");
    },
  );

  it.each([0, 42])("reports the route's cleared count %i", async (cleared) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(JSON.stringify({ cleared }))),
    );

    const result = await run(logsAction, "delete");

    expect(result?.success).toBe(true);
    expect(result?.text).toBe(`Cleared ${cleared} log entries.`);
    expect(result?.values).toMatchObject({ cleared });
  });
});

describe("RUNTIME reload_config acknowledgement", () => {
  it.each([
    "{}",
    '{"reloaded":false,"applied":[],"requiresRestart":[]}',
    '{"reloaded":"true","applied":[],"requiresRestart":[]}',
    '{"reloaded":true}',
    '{"reloaded":true,"applied":"logging","requiresRestart":[]}',
    '{"reloaded":true,"applied":[],"requiresRestart":[1]}',
    "[]",
  ])(
    "fails when a 2xx body is not a reload acknowledgement: %s",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respond(body)),
      );

      const result = await run(runtimeAction, "reload_config");

      expect(result?.success).toBe(false);
      expect(result?.values).toMatchObject({
        error: "RUNTIME_RELOAD_CONFIG_FAILED",
      });
      expect(result?.text).toContain("did not acknowledge the reload");
    },
  );

  it("fails when a 2xx body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond("<html>proxy</html>")),
    );

    const result = await run(runtimeAction, "reload_config");

    expect(result?.success).toBe(false);
    expect(result?.values).toMatchObject({
      error: "RUNTIME_RELOAD_CONFIG_FAILED",
    });
  });

  it("reports applied and restart-required fields from the acknowledgement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond(
          JSON.stringify({
            reloaded: true,
            applied: ["logging.level"],
            requiresRestart: ["database"],
          }),
        ),
      ),
    );

    const result = await run(runtimeAction, "reload_config");

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Applied: logging.level");
    expect(result?.text).toContain("Restart required for: database");
    expect(result?.values).toMatchObject({
      applied: ["logging.level"],
      requiresRestart: ["database"],
      restartNeeded: true,
    });
  });

  it("reports an acknowledged reload that changed nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond(
          JSON.stringify({ reloaded: true, applied: [], requiresRestart: [] }),
        ),
      ),
    );

    const result = await run(runtimeAction, "reload_config");

    expect(result?.success).toBe(true);
    expect(result?.text).toBe("No hot-reloadable fields changed.");
  });
});
