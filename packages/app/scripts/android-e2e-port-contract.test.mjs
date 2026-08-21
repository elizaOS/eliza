/**
 * Guards the Android E2E host-agent launch against reintroducing a fixed host
 * port while preserving the explicit CLI and environment override contract.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(import.meta.dirname, "android-e2e.mjs"),
  "utf8",
);
const globalSetupSource = readFileSync(
  join(import.meta.dirname, "../test/android/global-setup.ts"),
  "utf8",
);

describe("Android E2E host-agent port contract (#18359)", () => {
  it("delegates default allocation and accepts only explicit port overrides", () => {
    expect(source).toContain(
      'requestedPort: val(\n            "--host-agent-port",\n            process.env.ELIZA_ANDROID_HOST_AGENT_PORT,\n          )',
    );
    expect(source).not.toMatch(/requestedPort:\s*\d{4,5}\b/);
  });

  it("routes the canonical device port to the selected host port", () => {
    expect(globalSetupSource).toContain(
      "adbReverse(adb, serial, AGENT_API_PORT, HOST_AGENT_PORT)",
    );
    expect(globalSetupSource).toContain(
      "process.env.ELIZA_ANDROID_HOST_AGENT_PORT ?? AGENT_API_PORT",
    );
    expect(globalSetupSource).not.toContain(
      "adbReverse(adb, serial, AGENT_API_PORT, AGENT_API_PORT)",
    );
  });
});
