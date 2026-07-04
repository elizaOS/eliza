/**
 * Worker bootstrap tests verify that plugin descriptors and lifecycle hooks
 * wire into the remote runtime channel with deterministic in-memory fixtures.
 */
import { describe, expect, it } from "bun:test";
import type { RemotePluginWorkerMessage } from "../index.js";
import { bootstrap } from "./bootstrap.js";
import type { WorkerChannel } from "./envelope.js";

class TestChannel implements WorkerChannel {
  readonly sent: RemotePluginWorkerMessage[] = [];

  send(message: RemotePluginWorkerMessage): void {
    this.sent.push(message);
  }

  onMessage(): () => void {
    return () => {};
  }

  close(): void {}
}

describe("bootstrap", () => {
  it("announces plugin surfaces appended during init before init-complete", async () => {
    const channel = new TestChannel();
    const initialHandler = () => ({ ok: "initial" });
    const dynamicHandler = () => ({ ok: "dynamic" });
    const actions = [
      {
        name: "INITIAL",
        handler: initialHandler,
      },
    ];
    const plugin = {
      name: "dynamic-worker",
      actions,
      async init() {
        actions.push({
          name: "DYNAMIC",
          handler: dynamicHandler,
        });
      },
    };

    await bootstrap(plugin, { channel });

    expect(channel.sent.map((message) => message.type)).toEqual([
      "worker-announce-plugin",
      "worker-announce-dynamic",
      "init-complete",
    ]);

    const initialAnnounce = channel.sent[0];
    expect(initialAnnounce).toMatchObject({
      type: "worker-announce-plugin",
      descriptor: {
        name: "dynamic-worker",
        actions: [{ name: "INITIAL" }],
      },
    });

    const dynamicAnnounce = channel.sent[1];
    expect(dynamicAnnounce).toMatchObject({
      type: "worker-announce-dynamic",
      descriptor: {
        name: "dynamic-worker",
        actions: [{ name: "DYNAMIC" }],
      },
    });
  });
});
