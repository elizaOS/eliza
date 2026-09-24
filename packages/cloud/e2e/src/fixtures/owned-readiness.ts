/** Requires a fresh readiness announcement from the child whose HTTP server we test. */
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

export function trackOwnedReadiness(
  child: ChildProcess,
): (url: string) => boolean {
  const announced = new Set<string>();
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = stripVTControlCharacters(line).match(
        /\bReady on (https?:\/\/\S+)\s*$/,
      );
      if (match) announced.add(match[1]);
    }
  });
  return (url) => announced.has(url);
}

export async function waitForOwnedReadiness(
  child: ChildProcess,
  announced: (url: string) => boolean,
  url: string,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`[stack] owned server exited before announcing ${url}`);
    }
    if (announced(url)) return;
    await delay(50);
  }
  throw new Error(
    `[stack] owned server did not announce ${url} within ${timeoutMs}ms`,
  );
}
