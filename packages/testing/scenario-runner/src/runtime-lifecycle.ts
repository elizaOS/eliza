import { ElizaError } from "@elizaos/core";

/** Legacy host plugins read process.env, so a runner process owns at most one runtime. */
let active = false;
export function createScenarioRuntimeLifecycle() {
  if (active)
    throw new ElizaError(
      "A scenario runtime already owns this process; use separate subprocesses for parallel scenarios",
      { code: "SCENARIO_RUNTIME_ALREADY_ACTIVE" },
    );
  active = true;
  const before = { ...process.env };
  const resources: Array<{
    label: string;
    dispose: () => void | Promise<void>;
  }> = [];
  let closing: Promise<void> | undefined;
  return {
    own(label: string, dispose: () => void | Promise<void>) {
      resources.push({ label, dispose });
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const failures: unknown[] = [];
        for (const resource of resources.reverse()) {
          try {
            await resource.dispose();
          } catch (error) {
            // error-policy:J6 Attempt every owned disposer and report all failures.
            failures.push(error);
          }
        }

        // No other scenario may change the process environment while this scope owns it.
        for (const key of new Set([
          ...Object.keys(before),
          ...Object.keys(process.env),
        ])) {
          if (before[key] === undefined) delete process.env[key];
          else process.env[key] = before[key];
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            "Scenario runtime cleanup failed; this process must not be reused",
          );
        active = false;
      })();
      return closing;
    },
  };
}
