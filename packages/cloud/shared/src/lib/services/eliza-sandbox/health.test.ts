/** Exercises sandbox health contracts with deterministic external-boundary fixtures. Real durable authority is covered separately by the PGlite suites. */
import { afterEach, describe, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});
describe("container runtime health classification", () => {
  const closed = (
    header = "state=running health=unhealthy exit=1 oom=false restarts=2",
    overrides: string[] = [],
  ): string =>
    [
      header,
      "module_resolution=false",
      "heap_oom=false",
      "startup_failed=false",
      "terminal_database=false",
      "memory_watchdog=false",
      "port_conflict=false",
      "mesh_auth=false",
      ...overrides,
    ].join("\n");

  test("prioritizes authoritative OOM and closed fatal-log signals", async () => {
    const { classifyContainerRuntimeHealthObservation } = await import(
      "../eliza-sandbox.ts?actual"
    );

    expect(
      classifyContainerRuntimeHealthObservation(
        closed("state=exited health=unhealthy exit=137 oom=true restarts=5"),
      ),
    ).toEqual({ healthy: false, failureKind: "oom_killed" });
    expect(
      classifyContainerRuntimeHealthObservation(closed(undefined, ["module_resolution=true"])),
    ).toEqual({
      healthy: false,
      failureKind: "module_resolution",
    });
    expect(
      classifyContainerRuntimeHealthObservation(closed(undefined, ["terminal_database=true"])),
    ).toEqual({
      healthy: false,
      failureKind: "terminal_database",
    });
  });

  test("distinguishes healthy, restart, exit, and unavailable observations", async () => {
    const { classifyContainerRuntimeHealthObservation } = await import(
      "../eliza-sandbox.ts?actual"
    );

    expect(
      classifyContainerRuntimeHealthObservation(
        closed("state=running health=healthy exit=0 oom=false restarts=0"),
      ),
    ).toEqual({ healthy: true, failureKind: "healthy" });
    expect(
      classifyContainerRuntimeHealthObservation(
        closed("state=restarting health=starting exit=1 oom=false restarts=4"),
      ),
    ).toEqual({ healthy: false, failureKind: "restarting" });
    expect(
      classifyContainerRuntimeHealthObservation(
        closed("state=exited health=none exit=0 oom=false restarts=0"),
      ),
    ).toEqual({ healthy: false, failureKind: "exited_zero" });
    expect(classifyContainerRuntimeHealthObservation("missing")).toEqual({
      healthy: false,
      failureKind: "inspect_unavailable",
    });
  });
});
