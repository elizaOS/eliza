/**
 * @vitest-environment jsdom
 *
 * Proves the register-path import graph installs the LifeOps ElizaClient
 * prototype extension before the capture controller can run. The renderer's
 * `/register` entry loads the capture module without the PA root facade; if
 * the capture did not itself evaluate `../api/client-lifeops.js`,
 * `client.captureLifeOpsActivitySignal` would be undefined until the idle
 * facade load landed — lost boot-batch signals surfacing as spurious
 * capture_error (the #17056 adjudication's confirmed prototype race).
 *
 * Deliberately NO `vi.mock` of any `@elizaos/ui` specifier: the real
 * client-lifeops extension module runs against the package-level ElizaClient
 * and shared `client` instance, so this test imports exactly what the capture
 * imports and fails if the side-effect import is ever removed.
 */
import { describe, expect, it } from "vitest";

describe("register-path LifeOps client extension (prototype race)", () => {
  it("importing the capture module alone installs captureLifeOpsActivitySignal on the shared client", async () => {
    const { client } = await import("@elizaos/ui/api");
    // The capture module's own import graph — not this test, not the PA root
    // facade — must bring the prototype extension in.
    await import("./activity-signals-capture.js");
    const extended = client as {
      captureLifeOpsActivitySignal?: unknown;
    };
    expect(typeof extended.captureLifeOpsActivitySignal).toBe("function");
  });
});
