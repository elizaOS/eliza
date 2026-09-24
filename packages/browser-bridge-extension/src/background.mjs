/** Maintains native profile registration and consumes each browser command once across worker restarts. */

import { executeCommand } from "./commands.mjs";
import {
  BridgeError,
  encodeNativeMessage,
  NativeMessageAssembler,
  parseCommand,
} from "./protocol.mjs";
import { nativeHost } from "./runtime-config.mjs";

let port;
let connecting = false;
let processing = Promise.resolve();

async function handle(message, connection) {
  let request;
  try {
    request = parseCommand(message);
    const key = `request:${request.id}`;
    const previous = (await chrome.storage.local.get(key))[key];
    if (previous)
      throw new BridgeError(
        "UNCERTAIN_OUTCOME",
        "This request ID was already admitted; inspect the same tab before issuing a new request.",
      );
    await chrome.storage.local.set({ [key]: "admitted" });
    const result = await executeCommand(chrome, request.command);
    for (const frame of encodeNativeMessage({
      type: "result",
      id: request.id,
      ok: true,
      result,
    }))
      connection.postMessage(frame);
  } catch (error) {
    const reply = {
      type: "result",
      id:
        request?.id ??
        (typeof message?.id === "string" ? message.id : "invalid"),
      ok: false,
      error: {
        kind: error instanceof BridgeError ? error.kind : "UNCERTAIN_OUTCOME",
        message: error instanceof Error ? error.message : String(error),
      },
    };
    for (const frame of encodeNativeMessage(reply))
      connection.postMessage(frame);
  }
}

async function connect() {
  if (port || connecting) return;
  connecting = true;
  try {
    const stored = await chrome.storage.local.get("profileId");
    const profileId =
      typeof stored.profileId === "string"
        ? stored.profileId
        : crypto.randomUUID();
    if (!stored.profileId) await chrome.storage.local.set({ profileId });
    let connection;
    try {
      connection = chrome.runtime.connectNative(nativeHost);
    } catch (error) {
      // error-policy:J4 persist setup failure and retry; no command was admitted.
      await chrome.storage.local.set({ lastTransportError: String(error) });
      chrome.alarms.create("native-reconnect", { delayInMinutes: 0.5 });
      return;
    }
    port = connection;
    const assembler = new NativeMessageAssembler();
    connection.onMessage.addListener((frame) => {
      try {
        const message = assembler.accept(frame);
        if (message)
          processing = processing
            .then(() => handle(message, connection))
            .catch(async (error) => {
              // error-policy:J7 transport failure is recorded; admitted effects are never replayed.
              await chrome.storage.local.set({
                lastTransportError: String(error),
              });
            });
      } catch {
        // error-policy:J3 malformed native framing invalidates this connection before any command executes.
        connection.disconnect();
      }
    });
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port === connection) port = undefined;
      chrome.alarms.create("native-reconnect", { delayInMinutes: 0.5 });
    });
    connection.postMessage({
      type: "hello",
      protocol: 1,
      extensionId: chrome.runtime.id,
      profileId,
      capabilities: [
        "list",
        "open",
        "navigate",
        "snapshot",
        "click",
        "fill",
        "scroll",
        "back",
        "forward",
        "reload",
        "close",
      ],
    });
  } finally {
    connecting = false;
  }
}
chrome.runtime.onInstalled.addListener(() => {
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "native-reconnect") void connect();
});
void connect();
