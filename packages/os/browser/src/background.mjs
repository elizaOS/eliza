/** Maintains native profile registration and consumes each browser command once across worker restarts. */

import { executeCommand, prepareCommand } from "./commands.mjs";
import { NativeConnection } from "./native-connection.mjs";
import { BridgeError, parseCommand } from "./protocol.mjs";
import { nativeHost } from "./runtime-config.mjs";

let processing = Promise.resolve();

async function handle(message, sender, isCurrent) {
  let request;
  try {
    if (!isCurrent()) return;
    request = parseCommand(message);
    const key = `request:${request.id}`;
    const previous = (await chrome.storage.local.get(key))[key];
    if (previous)
      throw new BridgeError(
        "UNCERTAIN_OUTCOME",
        "This request ID was already admitted; inspect the same tab before issuing a new request.",
      );
    const prepared = await prepareCommand(chrome, request.command);
    if (!isCurrent()) return;
    await chrome.storage.local.set({ [key]: "admitted" });
    if (!isCurrent()) return;
    const result = await executeCommand(chrome, request.command, prepared);
    await sender.send({
      type: "result",
      id: request.id,
      ok: true,
      result,
    });
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
    await sender.send(reply);
  }
}

const connection = new NativeConnection({
  browser: chrome,
  nativeHost,
  hello: async () => {
    const stored = await chrome.storage.local.get("profileId");
    const profileId =
      typeof stored.profileId === "string"
        ? stored.profileId
        : crypto.randomUUID();
    if (!stored.profileId) await chrome.storage.local.set({ profileId });
    return {
      type: "hello",
      protocol: 2,
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
    };
  },
  onCommand: (message, sender, isCurrent) => {
    processing = processing.then(() => handle(message, sender, isCurrent));
    const admitted = processing;
    // Keep serialization usable after an ended transport; never replay its work.
    processing = processing.catch(() => {});
    return admitted;
  },
  report: (error) =>
    chrome.storage.local.set({ lastTransportError: String(error) }),
});
chrome.runtime.onInstalled.addListener(() => {
  void connection.check().catch((error) => connection.diagnose(error));
});
chrome.runtime.onStartup.addListener(() => {
  void connection.check().catch((error) => connection.diagnose(error));
});
void connection.start().catch((error) => connection.diagnose(error));
