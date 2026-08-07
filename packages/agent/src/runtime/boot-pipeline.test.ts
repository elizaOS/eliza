/**
 * Exercises the typed boot boundary with deterministic phase doubles, including
 * ordering, immutable environment capture, policy parsing, and reverse cleanup.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BOOT_PHASES,
  type BootPhase,
  captureAgentEnvironment,
  createBootContext,
  resolveBootPlan,
  resolveBootPolicy,
  runBootPhases,
} from "./boot-pipeline.ts";

describe("boot pipeline", () => {
  it("captures an immutable environment and parses named policy", () => {
    const source: NodeJS.ProcessEnv = {
      ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS: "yes",
      ELIZA_API_EXPOSE_PORT: "0",
    };
    const environment = captureAgentEnvironment(source);
    source.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = "no";

    expect(environment.get("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS")).toBe("yes");
    expect(resolveBootPolicy(environment)).toMatchObject({
      allowDestructiveMigrations: true,
      apiExposePort: false,
      preferredProviderPriorityBoost: 10,
    });
  });

  it("runs phases once in declared order and disposes in reverse order", async () => {
    const events: string[] = [];
    const context = createBootContext({
      environment: captureAgentEnvironment({}),
      observePhase: (phase) => events.push(`enter:${phase}`),
    });
    const phases: BootPhase[] = BOOT_PHASES.slice(0, 3).map((name) => ({
      name,
      run: () => {
        events.push(`run:${name}`);
      },
      dispose: () => {
        events.push(`dispose:${name}`);
      },
    }));

    const dispose = await runBootPhases(context, phases);
    await dispose();

    expect(context.completedPhases).toEqual(BOOT_PHASES.slice(0, 3));
    expect(events).toEqual([
      "enter:load-config",
      "run:load-config",
      "enter:resolve-settings",
      "run:resolve-settings",
      "enter:resolve-plugin-plan",
      "run:resolve-plugin-plan",
      "dispose:resolve-plugin-plan",
      "dispose:resolve-settings",
      "dispose:load-config",
    ]);
  });

  it("cleans completed phases when a later phase fails", async () => {
    const disposeFirst = vi.fn();
    const context = createBootContext({
      environment: captureAgentEnvironment({}),
    });

    await expect(
      runBootPhases(context, [
        { name: "load-config", run: vi.fn(), dispose: disposeFirst },
        {
          name: "resolve-settings",
          run: () => {
            throw new Error("settings failed");
          },
        },
      ]),
    ).rejects.toThrow("settings failed");
    expect(disposeFirst).toHaveBeenCalledOnce();
  });

  it("rejects duplicate or backward phase transitions", () => {
    const context = createBootContext({
      environment: captureAgentEnvironment({}),
    });
    context.enterPhase("resolve-settings");
    expect(() => context.enterPhase("load-config")).toThrow(
      "cannot follow resolve-settings",
    );
  });

  it.each([
    ["interactive", {}, true, false, true],
    ["headless", { headless: true }, false, false, true],
    ["server-only", { serverOnly: true }, true, false, true],
    [
      "local-agent",
      { serverOnly: true, localAgentMode: true },
      true,
      false,
      false,
    ],
    ["cloud", { headless: true }, true, true, true],
  ] as const)(
    "characterizes %s startup without running process infrastructure",
    (label, options, configured, cloudThinClient, bindApiListener) => {
      const plan = resolveBootPlan({
        ...options,
        configured,
        cloudThinClient,
        apiExposePort: false,
      });
      expect(plan).toMatchObject({
        hostMode: label === "cloud" ? "headless" : label,
        firstRun: !configured,
        runtimeMode: cloudThinClient ? "cloud" : "local",
        bindApiListener,
      });
    },
  );
});
