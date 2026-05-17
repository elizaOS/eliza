#!/usr/bin/env bun
import { startControlPlaneMock } from "../src/control-plane";

const port = Number(process.env.PORT ?? process.env.CONTAINER_CONTROL_PLANE_PORT ?? 8791);
const hostname = process.env.HOST ?? "127.0.0.1";
const tickMs = Number(process.env.CONTROL_PLANE_TICK_MS ?? 1000);
const hetznerUrl = process.env.HCLOUD_API_BASE_URL ?? "http://127.0.0.1:8790/v1";

const mock = await startControlPlaneMock({
  port,
  hostname,
  hetznerUrl,
  tickMs,
});

// eslint-disable-next-line no-console
console.log(`[control-plane-mock] listening on ${mock.url} (hetzner=${hetznerUrl}, tick=${tickMs}ms)`);

const shutdown = async () => {
  await mock.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
