/** Real runtime event dispatch with a deterministic connection-warming boundary. */
import { AgentRuntime, EventType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiPlugin } from "../index";

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

async function createRuntime(baseURL: string) {
  const runtime = new AgentRuntime({
    character: { name: "preconnect-test", bio: [], settings: { OPENAI_BASE_URL: baseURL } },
  });
  runtimes.push(runtime);
  await runtime.registerPlugin(openaiPlugin);
  return runtime;
}

function installPreconnect(preconnect?: (url: string) => void) {
  const request = vi.fn(async () => {
    throw new Error("Preconnection must not dispatch an HTTP request");
  });
  vi.stubGlobal("fetch", Object.assign(request, { preconnect }));
  return request;
}

describe("provider connection warming on ingress", () => {
  it("throttles repeated text and voice ingress while allowing later warm-up", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const preconnect = vi.fn();
    const request = installPreconnect(preconnect);
    const runtime = await createRuntime("https://first.example/v1");
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {});
    await runtime.emitEvent(EventType.VOICE_MESSAGE_RECEIVED, {});
    expect(preconnect.mock.calls).toEqual([["https://first.example/v1"]]);
    now = 16_000;
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {});
    expect(preconnect).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  });

  it("warms independent runtimes and changed endpoints during the same throttle window", async () => {
    const preconnect = vi.fn();
    installPreconnect(preconnect);
    const first = await createRuntime("https://first.example/v1");
    const second = await createRuntime("https://second.example/v1");
    await first.emitEvent(EventType.MESSAGE_RECEIVED, {});
    await second.emitEvent(EventType.MESSAGE_RECEIVED, {});
    first.setSetting("OPENAI_BASE_URL", "https://replacement.example/v1");
    await first.emitEvent(EventType.VOICE_MESSAGE_RECEIVED, {});
    expect(preconnect.mock.calls).toEqual([
      ["https://first.example/v1"],
      ["https://second.example/v1"],
      ["https://replacement.example/v1"],
    ]);
  });

  it("reports connection failure without rejecting ingress or issuing HTTP", async () => {
    const cause = new Error("connection unavailable");
    const request = installPreconnect(() => {
      throw cause;
    });
    const runtime = await createRuntime("https://failure.example/v1");
    const report = vi.spyOn(runtime, "reportError");
    await expect(runtime.emitEvent(EventType.MESSAGE_RECEIVED, {})).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(
      "openai:preconnect",
      expect.objectContaining({ code: "OPENAI_PRECONNECT_FAILED", cause })
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts ingress in runtimes without preconnect support", async () => {
    const request = installPreconnect();
    const runtime = await createRuntime("https://unsupported.example/v1");
    await expect(runtime.emitEvent(EventType.MESSAGE_RECEIVED, {})).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
