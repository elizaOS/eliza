/** Implements Electrobun runtime remote phase1 smoke ts boundaries for desktop app-core. */
import { RuntimeLogBuffer } from "../bun/log-buffer.ts";
import type { RuntimeManagerEvent } from "../bun/protocol.ts";
import { ElizaRuntimeManager } from "../bun/runtime-manager.ts";

function write(value: string): void {
  process.stdout.write(`${value}\n`);
}

function printJson(label: string, value: object): void {
  write(`${label}: ${JSON.stringify(value, null, 2)}`);
}

const logBuffer = new RuntimeLogBuffer();
const manager = new ElizaRuntimeManager({
  logBuffer,
  onEvent: (event: RuntimeManagerEvent) => {
    if (event.name === "runtime.error") {
      write(`event ${event.name}: ${JSON.stringify(event.payload)}`);
    }
  },
});

printJson("initial status", manager.status());

await manager.start();
printJson("status after start", manager.status());

const health = await manager.health();
printJson("health", health);

printJson("last 20 logs", { logs: manager.logsTail(20) });

await manager.stop();
printJson("final status", manager.status());
