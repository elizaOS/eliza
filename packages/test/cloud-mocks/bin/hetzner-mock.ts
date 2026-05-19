#!/usr/bin/env bun
import { startHetznerMock } from "../src/hetzner";

function parseFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const portArg = parseFlag("port");
const actionMsArg = parseFlag("action-ms");

const port = portArg ? Number.parseInt(portArg, 10) : Number(process.env.PORT ?? 4567);
const actionMs = actionMsArg ? Number.parseInt(actionMsArg, 10) : undefined;

const running = await startHetznerMock({ port, actionMs });
console.log(`[hetzner-mock] listening at ${running.url}`);
console.log(`[hetzner-mock] export HCLOUD_API_BASE_URL=${running.url}`);

const shutdown = async (signal: string) => {
  console.log(`[hetzner-mock] received ${signal}, shutting down`);
  await running.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
