import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { AudioRouter } from "./audioRouter";

describe("AudioRouter", () => {
  it("adds a target to a live route using the stored source stream", async () => {
    const router = new AudioRouter();
    const source = new PassThrough();
    const received: Record<string, string> = { alpha: "", beta: "" };
    const playbackDone = new Map<string, Promise<void>>();

    const createTarget = (id: "alpha" | "beta") => ({
      id,
      type: "test",
      feed: async (stream: NodeJS.ReadableStream) => {
        playbackDone.set(
          id,
          new Promise<void>((resolve, reject) => {
            stream.on("data", (chunk) => {
              received[id] += chunk.toString();
            });
            stream.on("end", () => resolve());
            stream.on("error", reject);
          }),
        );
      },
      stop: async () => undefined,
    });

    router.registerTargets([createTarget("alpha"), createTarget("beta")]);

    await router.route("main", source, ["alpha"]);
    source.write("before");
    await delay(5);

    await router.addTargetToRoute("main", "beta");
    source.write("after");
    source.end();

    await Promise.all(Array.from(playbackDone.values()));

    expect(received.alpha).toBe("beforeafter");
    expect(received.beta).toBe("after");
    expect(router.getRoute("main")).toEqual({
      sourceId: "main",
      targetIds: ["alpha", "beta"],
      mode: "simulcast",
    });
  });
});
