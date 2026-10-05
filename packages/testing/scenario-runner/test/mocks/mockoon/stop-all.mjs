#!/usr/bin/env node
/** Stop only the authenticated mock owner; never signal a recycled PID. */
import { access, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { testOutputPath } from "../../../../../scripts/lib/test-output.ts";

const recordPath = testOutputPath("mock-services", "control.json");
let raw;
try {
  raw = await readFile(recordPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log("No managed mock services");
  process.exit(0);
}
const record = JSON.parse(raw);
const endpoint = new URL(record.url);
if (
  record.version !== 1 ||
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== "/" ||
  endpoint.search ||
  endpoint.hash ||
  !/^[0-9a-f]{64}$/.test(record.token)
)
  throw new Error("Invalid mock owner record");
const response = await fetch(new URL("/stop", endpoint), {
  method: "POST",
  headers: { authorization: `Bearer ${record.token}` },
  signal: AbortSignal.timeout(10_000),
  redirect: "error",
});
if (!response.ok)
  throw new Error(`Mock owner refused shutdown: ${response.status}`);
await response.text();
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  try {
    await access(recordPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Mock services stopped");
      process.exit(0);
    }
    throw error;
  }
  await delay(50);
}
throw new Error(
  "Mock shutdown has not removed its owned control record; inspect daemon.log",
);
