/** Real process proof: cleanup must outlive the retired 30-second race. */
import { expect, test } from "bun:test";

const child = `
import { setTimeout as delay } from "node:timers/promises";
import { createScenarioRuntimeLifecycle } from ${JSON.stringify(new URL("../../scenario-runner/src/runtime-lifecycle.ts", import.meta.url).href)};
const key = "ELIZA_SCENARIO_LIFECYCLE_SUBPROCESS";
process.env[key] = "before";
const scope = createScenarioRuntimeLifecycle();
process.env[key] = "owned";
const events = [];
const drained = Promise.withResolvers();
scope.own("dependent resource", () => events.push({ phase: "dependent", env: process.env[key] }));
scope.own("slow disposer", async () => { await delay(31_000); events.push({ phase: "finished", env: process.env[key] }); drained.resolve(); });
let closeFailed = false;
try { await scope.close(); } catch { closeFailed = true; }
const restored = process.env[key];
await drained.promise;
let failureRetained = false;
let quarantined = false;
if (!closeFailed) {
const failure = createScenarioRuntimeLifecycle();
failure.own("failed disposer", () => { throw new Error("deliberate teardown failure"); });
try { await failure.close(); } catch (error) { failureRetained = error instanceof AggregateError && error.errors[0]?.message === "deliberate teardown failure"; }
}
try { createScenarioRuntimeLifecycle(); } catch { quarantined = true; }
process.stdout.write(JSON.stringify({ events, restored, closeFailed, failureRetained, quarantined }));
`;

test("waits for the real disposer before dependent cleanup or environment restoration", async () => {
  const process = Bun.spawn(
    [Bun.argv[0], "--conditions=eliza-source", "-e", child],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      events: [
        { phase: "finished", env: "owned" },
        { phase: "dependent", env: "owned" },
      ],
      restored: "before",
      closeFailed: false,
      failureRetained: true,
      quarantined: true,
    });
  } finally {
    process.kill();
    await process.exited;
  }
}, 60_000);
