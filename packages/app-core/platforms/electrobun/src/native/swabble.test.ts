/**
 * Exercises SwabbleManager start/stop, config merge, audio-chunk passthrough
 * branches, dispose, and getSwabbleManager against the real native wake-word
 * module using a recorder sendToWebview collaborator.
 */
import { describe, expect, it } from "vitest";
import { getSwabbleManager, SwabbleManager } from "./swabble";

type RecordedEvent = {
  message: string;
  payload: unknown;
};

function createRecorder(): {
  events: RecordedEvent[];
  send: (message: string, payload?: unknown) => void;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    send: (message, payload) => {
      events.push({ message, payload });
    },
  };
}

describe("SwabbleManager", () => {
  it("exposes the default wake-word config before start", async () => {
    const manager = new SwabbleManager();

    await expect(manager.getConfig()).resolves.toEqual({
      triggers: ["hey eliza", "eliza"],
      minPostTriggerGap: 0.45,
      minCommandLength: 1,
      enabled: true,
    });
  });

  it("reports not listening before start", async () => {
    const manager = new SwabbleManager();

    await expect(manager.isListening()).resolves.toEqual({ listening: false });
  });

  it("starts without a sendToWebview collaborator", async () => {
    const manager = new SwabbleManager();

    await expect(manager.start()).resolves.toEqual({ started: true });
    await expect(manager.isListening()).resolves.toEqual({ listening: true });
  });

  it("emits swabble:stateChange listening true on start", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);

    await manager.start();

    expect(recorder.events).toEqual([
      { message: "swabble:stateChange", payload: { listening: true } },
    ]);
  });

  it("merges a partial config on start and keeps unspecified defaults", async () => {
    const manager = new SwabbleManager();

    await manager.start({ config: { enabled: false, minCommandLength: 4 } });

    await expect(manager.getConfig()).resolves.toEqual({
      triggers: ["hey eliza", "eliza"],
      minPostTriggerGap: 0.45,
      minCommandLength: 4,
      enabled: false,
    });
  });

  it("replaces triggers with a single-element list", async () => {
    const manager = new SwabbleManager();

    await manager.start({ config: { triggers: ["eliza"] } });

    const config = await manager.getConfig();
    expect(config.triggers).toEqual(["eliza"]);
  });

  it("replaces triggers with an empty list", async () => {
    const manager = new SwabbleManager();

    await manager.start({ config: { triggers: [] } });

    const config = await manager.getConfig();
    expect(config.triggers).toEqual([]);
  });

  it("keeps merged config when a later start omits config", async () => {
    const manager = new SwabbleManager();

    await manager.start({ config: { minPostTriggerGap: 1.25 } });
    await manager.start();

    const config = await manager.getConfig();
    expect(config.minPostTriggerGap).toBe(1.25);
  });

  it("applies an empty config object as a no-op merge", async () => {
    const manager = new SwabbleManager();

    await manager.start({ config: {} });

    await expect(manager.getConfig()).resolves.toEqual({
      triggers: ["hey eliza", "eliza"],
      minPostTriggerGap: 0.45,
      minCommandLength: 1,
      enabled: true,
    });
  });

  it("emits swabble:stateChange listening false on stop", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);
    await manager.start();
    recorder.events.length = 0;

    await manager.stop();

    expect(recorder.events).toEqual([
      { message: "swabble:stateChange", payload: { listening: false } },
    ]);
    await expect(manager.isListening()).resolves.toEqual({ listening: false });
  });

  it("stops without a sendToWebview collaborator", async () => {
    const manager = new SwabbleManager();
    await manager.start();

    await expect(manager.stop()).resolves.toBeUndefined();
    await expect(manager.isListening()).resolves.toEqual({ listening: false });
  });

  it("returns a shallow copy from getConfig so top-level fields are isolated", async () => {
    const manager = new SwabbleManager();
    const copy = await manager.getConfig();
    copy.enabled = false;
    copy.minCommandLength = 99;

    await expect(manager.getConfig()).resolves.toMatchObject({
      enabled: true,
      minCommandLength: 1,
    });
  });

  it("shares the nested triggers array through the shallow getConfig copy", async () => {
    const manager = new SwabbleManager();
    const copy = await manager.getConfig();
    if (!Array.isArray(copy.triggers)) {
      throw new Error("expected getConfig().triggers to be an array");
    }
    copy.triggers.push("wake up");

    const later = await manager.getConfig();
    expect(later.triggers).toEqual(["hey eliza", "eliza", "wake up"]);
  });

  it("assigns unknown keys onto config via updateConfig", async () => {
    const manager = new SwabbleManager();

    await manager.updateConfig({
      minCommandLength: 3,
      extraFlag: true,
    });

    await expect(manager.getConfig()).resolves.toMatchObject({
      minCommandLength: 3,
      extraFlag: true,
      enabled: true,
    });
  });

  it("does not emit stateChange from updateConfig", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);

    await manager.updateConfig({ enabled: false });

    expect(recorder.events).toEqual([]);
  });

  it("forwards audio chunks while enabled and listening", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);
    await manager.start();
    recorder.events.length = 0;

    await manager.audioChunk({ data: "Zm9v" });

    expect(recorder.events).toEqual([
      { message: "swabble:audioChunkPush", payload: { data: "Zm9v" } },
    ]);
  });

  it("forwards an empty audio payload while listening", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);
    await manager.start();
    recorder.events.length = 0;

    await manager.audioChunk({ data: "" });

    expect(recorder.events).toEqual([
      { message: "swabble:audioChunkPush", payload: { data: "" } },
    ]);
  });

  it("forwards consecutive audio chunks in call order", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);
    await manager.start();
    recorder.events.length = 0;

    await manager.audioChunk({ data: "one" });
    await manager.audioChunk({ data: "two" });

    expect(recorder.events.map((event) => event.payload)).toEqual([
      { data: "one" },
      { data: "two" },
    ]);
  });

  it("drops audio chunks when not listening", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);

    await manager.audioChunk({ data: "silent" });

    expect(recorder.events).toEqual([]);
  });

  it("drops audio chunks when enabled is false even while listening", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);
    await manager.start({ config: { enabled: false } });
    recorder.events.length = 0;

    await manager.audioChunk({ data: "disabled" });

    expect(recorder.events).toEqual([]);
    await expect(manager.isListening()).resolves.toEqual({ listening: true });
  });

  it("drops audio chunks after stop even when still enabled", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);
    await manager.start();
    await manager.stop();
    recorder.events.length = 0;

    await manager.audioChunk({ data: "after-stop" });

    expect(recorder.events).toEqual([]);
  });

  it("resumes audio forwarding after a second start", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);
    await manager.start();
    await manager.stop();
    await manager.start();
    recorder.events.length = 0;

    await manager.audioChunk({ data: "again" });

    expect(recorder.events).toEqual([
      { message: "swabble:audioChunkPush", payload: { data: "again" } },
    ]);
  });

  it("does not throw audioChunk without a sendToWebview collaborator", async () => {
    const manager = new SwabbleManager();
    await manager.start();

    await expect(
      manager.audioChunk({ data: "orphan" }),
    ).resolves.toBeUndefined();
  });

  it("clears listening and the collaborator on dispose", async () => {
    const manager = new SwabbleManager();
    const recorder = createRecorder();
    manager.setSendToWebview(recorder.send);
    await manager.start();
    recorder.events.length = 0;

    manager.dispose();

    await expect(manager.isListening()).resolves.toEqual({ listening: false });
    expect(recorder.events).toEqual([]);

    await manager.start();
    await manager.audioChunk({ data: "post-dispose" });
    expect(recorder.events).toEqual([]);
  });

  it("accepts a new sendToWebview collaborator after dispose", async () => {
    const manager = new SwabbleManager();
    const first = createRecorder();
    manager.setSendToWebview(first.send);
    manager.dispose();

    const second = createRecorder();
    manager.setSendToWebview(second.send);
    await manager.start();
    await manager.audioChunk({ data: "revived" });

    expect(first.events).toEqual([]);
    expect(second.events).toEqual([
      { message: "swabble:stateChange", payload: { listening: true } },
      { message: "swabble:audioChunkPush", payload: { data: "revived" } },
    ]);
  });
});

describe("getSwabbleManager", () => {
  it("returns the same SwabbleManager instance on repeated calls", () => {
    const first = getSwabbleManager();
    const second = getSwabbleManager();

    expect(first).toBeInstanceOf(SwabbleManager);
    expect(second).toBe(first);
  });
});
