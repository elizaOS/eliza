/** Executes returned popup scripts with a recorded opener and inert close timers. */
import { runInNewContext } from "node:vm";

export function capturePopupMessages(html: string, opener: "open" | "closed" | "absent" = "open") {
  const messages: Array<{ payload: unknown; targetOrigin: string }> = [];
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  if (scripts.length === 0) throw new Error("Popup response contains no executable script");
  const window = {
    opener:
      opener === "absent"
        ? null
        : {
            closed: opener === "closed",
            postMessage: (payload: unknown, targetOrigin: string) =>
              messages.push({ payload, targetOrigin }),
          },
    location: { origin: "https://callback.invalid" },
    setTimeout: () => 0,
    close: () => {},
  };
  for (const [, script] of scripts) {
    runInNewContext(script, { window, setTimeout: window.setTimeout }, { timeout: 1000 });
  }
  return messages;
}
