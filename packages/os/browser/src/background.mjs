/** Maintains native profile registration and consumes each browser command once across worker restarts. */

import { createCommandHandler } from "./command-handler.mjs";
import { NativeConnection } from "./native-connection.mjs";
import { nativeHost } from "./runtime-config.mjs";

const handleCommand = createCommandHandler(chrome);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === "task-guide-answer") {
    // The page receives only whether the value-free answer reached the host.
    void Promise.resolve()
      .then(() => connection.notify(handleCommand.answerGuide(message, sender)))
      .then(
        () => reply({ delivered: true }),
        () => reply({ delivered: false }),
      );
    return true;
  }
  if (message?.type !== "task-manual-activity") return false;
  void handleCommand
    .recordManualActivity(message, sender)
    .then(reply, () => reply({ recorded: false }));
  return true;
});

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
        "cancel",
        "task-bind",
        "task-guide",
        "task-guide-label",
        "task-action-feedback",
        "task-manual-activity",
        "task-protected-fill",
      ],
    };
  },
  onCommand: handleCommand,
  onDisconnect: () => handleCommand.disconnect(),
  beforeConnect: () => handleCommand.recover(),
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
