/** Exercises kiosk canvas behavior with deterministic app-core test fixtures. */
import type { JsonValue } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { SendToWebview } from "../types";
import {
  KIOSK_VIEW_EVENT_MESSAGE,
  KioskCanvas,
  type KioskViewEvent,
} from "./kiosk-canvas";

type SentCall = {
  message: string;
  payload: unknown;
};

function recordingSender(): {
  send: SendToWebview;
  sent: SentCall[];
} {
  const sent: SentCall[] = [];
  return {
    sent,
    send: (message, payload) => {
      sent.push({ message, payload });
    },
  };
}

function asViewEvent(payload: unknown): KioskViewEvent {
  if (payload === null || typeof payload !== "object" || !("kind" in payload)) {
    throw new Error("kiosk canvas sent a non-event payload");
  }
  return payload as KioskViewEvent;
}

describe("KioskCanvas", () => {
  it("exports the renderer-bound kiosk view event channel name", () => {
    expect(KIOSK_VIEW_EVENT_MESSAGE).toBe("kioskViewEvent");
  });

  it("mounts a window with empty-option defaults and a sequential kiosk-view id", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);

    const created = await canvas.createWindow({});

    expect(created.id).toMatch(/^kiosk-view_\d+$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toBe(KIOSK_VIEW_EVENT_MESSAGE);
    expect(asViewEvent(sent[0]?.payload)).toEqual({
      kind: "mount",
      windowId: created.id,
      url: "",
      title: "View",
      width: 760,
      height: 520,
      alwaysOnTop: false,
    });
  });

  it("mounts a window with caller-supplied url, title, size, and alwaysOnTop", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);

    const created = await canvas.createWindow({
      url: "https://example.invalid/view",
      title: "Trace",
      width: 1280,
      height: 720,
      alwaysOnTop: true,
      x: 12,
      y: 34,
      transparent: true,
    });

    const event = asViewEvent(sent[0]?.payload);
    expect(event).toEqual({
      kind: "mount",
      windowId: created.id,
      url: "https://example.invalid/view",
      title: "Trace",
      width: 1280,
      height: 720,
      alwaysOnTop: true,
    });
    expect(event).not.toHaveProperty("x");
    expect(event).not.toHaveProperty("y");
    expect(event).not.toHaveProperty("transparent");
  });

  it("preserves empty title and zero size because nullish defaults do not replace them", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);

    await canvas.createWindow({
      url: "",
      title: "",
      width: 0,
      height: 0,
      alwaysOnTop: false,
    });

    expect(asViewEvent(sent[0]?.payload)).toMatchObject({
      kind: "mount",
      url: "",
      title: "",
      width: 0,
      height: 0,
      alwaysOnTop: false,
    });
  });

  it("assigns strictly increasing ids across consecutive creates on one canvas", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);

    const first = await canvas.createWindow({ title: "one" });
    const second = await canvas.createWindow({ title: "two" });

    const firstN = Number(first.id.slice("kiosk-view_".length));
    const secondN = Number(second.id.slice("kiosk-view_".length));
    expect(secondN).toBe(firstN + 1);
    expect(first.id).not.toBe(second.id);
    expect(sent).toHaveLength(2);
    expect(asViewEvent(sent[0]?.payload).windowId).toBe(first.id);
    expect(asViewEvent(sent[1]?.payload).windowId).toBe(second.id);
  });

  it("shares the module-level id counter across canvas instances", async () => {
    const first = recordingSender();
    const second = recordingSender();
    const left = new KioskCanvas(first.send);
    const right = new KioskCanvas(second.send);

    const fromLeft = await left.createWindow({ title: "left" });
    const fromRight = await right.createWindow({ title: "right" });

    const leftN = Number(fromLeft.id.slice("kiosk-view_".length));
    const rightN = Number(fromRight.id.slice("kiosk-view_".length));
    expect(rightN).toBe(leftN + 1);
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
    expect(asViewEvent(first.sent[0]?.payload).windowId).toBe(fromLeft.id);
    expect(asViewEvent(second.sent[0]?.payload).windowId).toBe(fromRight.id);
  });

  it("unmounts an existing window by id without touching other mounted views", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);
    const keep = await canvas.createWindow({ title: "keep" });
    const drop = await canvas.createWindow({ title: "drop" });
    sent.length = 0;

    await canvas.destroyWindow({ id: drop.id });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toBe(KIOSK_VIEW_EVENT_MESSAGE);
    expect(asViewEvent(sent[0]?.payload)).toEqual({
      kind: "unmount",
      windowId: drop.id,
    });
    expect(asViewEvent(sent[0]?.payload).windowId).not.toBe(keep.id);
  });

  it("still emits unmount when the id was never mounted", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);

    await canvas.destroyWindow({ id: "kiosk-view_missing" });

    expect(sent).toEqual([
      {
        message: KIOSK_VIEW_EVENT_MESSAGE,
        payload: { kind: "unmount", windowId: "kiosk-view_missing" },
      },
    ]);
  });

  it("pushes an a2ui payload to the requested window id, including nested json", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);
    const created = await canvas.createWindow({ title: "a2ui" });
    sent.length = 0;
    const payload: JsonValue = {
      type: "dynamic-view.event",
      nested: { ok: true, n: 3 },
      list: ["a", 1, null],
    };

    await canvas.a2uiPush({ id: created.id, payload });

    expect(asViewEvent(sent[0]?.payload)).toEqual({
      kind: "a2ui",
      windowId: created.id,
      payload,
    });
  });

  it("pushes a2ui to an unknown window id because membership is not checked", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);

    await canvas.a2uiPush({
      id: "kiosk-view_never-created",
      payload: "hello",
    });

    expect(asViewEvent(sent[0]?.payload)).toEqual({
      kind: "a2ui",
      windowId: "kiosk-view_never-created",
      payload: "hello",
    });
  });

  it("routes every canvas method through the same webview message name", async () => {
    const { send, sent } = recordingSender();
    const canvas = new KioskCanvas(send);

    const created = await canvas.createWindow({ title: "channel" });
    await canvas.a2uiPush({ id: created.id, payload: 1 });
    await canvas.destroyWindow({ id: created.id });

    expect(sent.map((call) => call.message)).toEqual([
      KIOSK_VIEW_EVENT_MESSAGE,
      KIOSK_VIEW_EVENT_MESSAGE,
      KIOSK_VIEW_EVENT_MESSAGE,
    ]);
    expect(sent.map((call) => asViewEvent(call.payload).kind)).toEqual([
      "mount",
      "a2ui",
      "unmount",
    ]);
  });
});
