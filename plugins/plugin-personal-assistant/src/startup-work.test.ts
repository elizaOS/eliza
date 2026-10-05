import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { PersonalAssistantStartupService } from "./startup-work";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("personal assistant startup ownership", () => {
  it("cancels waiting startup work and retry delays without running it", async () => {
    const ready = deferred();
    const service = await PersonalAssistantStartupService.start({
      initPromise: ready.promise,
    } as IAgentRuntime);
    const work = vi.fn();
    service.runAfterInit(work, vi.fn());
    const delay = service.wait(60_000);
    await service.stop();
    await delay;
    ready.resolve();
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled();
  });

  it("drains admitted work and its diagnostic persistence before releasing storage", async () => {
    const read = deferred();
    const diagnostic = deferred();
    const started = deferred();
    const reporting = deferred();
    const service = await PersonalAssistantStartupService.start({
      initPromise: Promise.resolve(),
    } as IAgentRuntime);
    service.runAfterInit(
      async () => {
        started.resolve();
        await read.promise;
        throw new Error("fixture failure");
      },
      async () => {
        reporting.resolve();
        await diagnostic.promise;
      },
    );
    await started.promise;
    read.resolve();
    await reporting.promise;
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    diagnostic.resolve();
    await stop;
    expect(stopped).toBe(true);
  });
});
