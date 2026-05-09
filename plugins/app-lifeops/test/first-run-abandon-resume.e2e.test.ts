/**
 * First-run abandon / resume e2e — partial answers persist Q-by-Q so a user
 * who walks away mid-customize can pick up where they left off.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { FirstRunService } from "../src/lifeops/first-run/service.ts";
import {
  createFirstRunStateStore,
  createOwnerFactStore,
} from "../src/lifeops/first-run/state.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

function newService(runtime: IAgentRuntime): FirstRunService {
  return new FirstRunService(runtime, {
    stateStore: createFirstRunStateStore(runtime),
    factStore: createOwnerFactStore(runtime),
  });
}

describe("first-run abandon / resume e2e", () => {
  it("partial answers persist between runService calls", async () => {
    const runtime = createMinimalRuntimeStub() as unknown as IAgentRuntime;
    let service = newService(runtime);

    // Q1
    let res = await service.runCustomizePath({ preferredName: "Sam" });
    expect(res.awaitingQuestion).toBe("timezoneAndWindows");

    // Q2 — partial — only timezone, missing windows.
    res = await service.runCustomizePath({ timezone: "America/Chicago" });
    // Still on the same Q because windows missing.
    expect(res.awaitingQuestion).toBe("timezoneAndWindows");

    // Simulate "abandon" — drop the service and re-create. Partial state
    // should rehydrate from the cache-backed FirstRunStateStore.
    service = newService(runtime);
    const stateStore = createFirstRunStateStore(runtime);
    const recovered = await stateStore.read();
    expect(recovered.status).toBe("in_progress");
    expect(recovered.partialAnswers.preferredName).toBe("Sam");
    expect(recovered.partialAnswers.timezone).toBe("America/Chicago");

    // Q2 — finish windows.
    res = await service.runCustomizePath({
      morningWindow: { startLocal: "06:00", endLocal: "11:00" },
      eveningWindow: { startLocal: "18:00", endLocal: "22:00" },
    });
    expect(res.awaitingQuestion).toBe("categories");

    // Continue to completion.
    res = await service.runCustomizePath({ categories: ["reminder packs"] });
    expect(res.awaitingQuestion).toBe("channel");
    res = await service.runCustomizePath({ channel: "in_app" });
    expect(res.status).toBe("ok");
    expect(res.facts.preferredName).toBe("Sam");
    expect(res.facts.timezone).toBe("America/Chicago");
  });

  it("provider stays loud while abandoned-in-progress and goes quiet on completion", async () => {
    const runtime = createMinimalRuntimeStub() as unknown as IAgentRuntime;
    const service = newService(runtime);
    await service.runCustomizePath({ preferredName: "Sam" });

    const { firstRunProvider } = await import("../src/providers/first-run.ts");
    const surface = await firstRunProvider.get(
      runtime,
      {
        id: "msg" as never,
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        agentId: runtime.agentId,
        content: { text: "" },
        createdAt: Date.now(),
      } as never,
      { values: {}, data: {}, text: "" } as never,
    );
    expect(surface.values?.firstRunPending).toBe(true);
    expect(surface.text).toMatch(/in progress/i);

    // Finish
    await service.runCustomizePath({
      timezone: "UTC",
      morningWindow: { startLocal: "06:00", endLocal: "11:00" },
      eveningWindow: { startLocal: "18:00", endLocal: "22:00" },
    });
    await service.runCustomizePath({ categories: ["reminder packs"] });
    await service.runCustomizePath({ channel: "in_app" });

    const surfaceAfter = await firstRunProvider.get(
      runtime,
      {
        id: "msg" as never,
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        agentId: runtime.agentId,
        content: { text: "" },
        createdAt: Date.now(),
      } as never,
      { values: {}, data: {}, text: "" } as never,
    );
    expect(surfaceAfter.values?.firstRunPending).toBe(false);
  });
});
