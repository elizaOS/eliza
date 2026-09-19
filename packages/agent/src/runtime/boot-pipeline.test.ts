/**
 * Exercises the active boot context and plan with deterministic environment
 * snapshots, phase transitions, policy parsing, and host-mode selection.
 */
import { describe, expect, it } from "vitest";
import {
  captureAgentEnvironment,
  createBootContext,
  resolveBootPlan,
  resolveBootPolicy,
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

  it("records admitted phases and rejects duplicate or backward transitions", () => {
    const observed: string[] = [];
    const context = createBootContext({
      environment: captureAgentEnvironment({}),
      observePhase: (phase) => observed.push(phase),
    });
    context.enterPhase("resolve-settings");
    expect(context.completedPhases).toEqual(["resolve-settings"]);
    expect(observed).toEqual(["resolve-settings"]);
    expect(() => context.enterPhase("resolve-settings")).toThrow();
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
