#!/usr/bin/env node
// Usage: bun run src/cli.ts -- --device meta-quest --url ws://localhost:31338
// Or:    node dist/cli.js --device simulator --url ws://localhost:31338

import { DeviceEmulator, type FacewearDeviceType } from "./device-emulator.ts";

function parseArgs(): { device: FacewearDeviceType; url: string } {
  const args = process.argv.slice(2);
  let device: FacewearDeviceType = "simulator";
  let url = "ws://localhost:31338";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device" && args[i + 1]) {
      device = args[++i] as FacewearDeviceType;
    } else if (args[i] === "--url" && args[i + 1]) {
      url = args[++i];
    }
  }

  return { device, url };
}

async function main(): Promise<void> {
  const { device, url } = parseArgs();
  const emulator = new DeviceEmulator(device);

  emulator.onMessage((msg) => {
    console.log(`[facewear-emulator] Message: ${JSON.stringify(msg)}`);
  });

  try {
    await emulator.connect(url);
  } catch (err) {
    console.error(`[facewear-emulator] Connection failed:`, err);
    process.exit(1);
  }

  const sessionId = emulator.getSessionId();
  console.log(`[facewear-emulator] Connected as ${device} (session: ${sessionId})`);

  const pingInterval = setInterval(() => {
    emulator.sendControl({ type: "ping" });
  }, 5000);

  process.on("SIGINT", () => {
    clearInterval(pingInterval);
    emulator.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
