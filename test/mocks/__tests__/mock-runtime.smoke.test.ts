import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MOCK_ENVIRONMENTS, startMocks } from "../scripts/start-mocks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENVS_DIR = path.resolve(__dirname, "..", "environments");

const availableEnvs = MOCK_ENVIRONMENTS.filter((name) =>
  fs.existsSync(path.resolve(ENVS_DIR, `${name}.json`)),
);

describe("mockoon harness smoke test", () => {
  it("has a fixture file for every configured mock environment", () => {
    expect(availableEnvs).toEqual([...MOCK_ENVIRONMENTS]);
  });

  it("starts and stops every configured environment", async () => {
    const mocks = await startMocks({ envs: MOCK_ENVIRONMENTS });
    try {
      for (const [, port] of Object.entries(mocks.portMap)) {
        // Hitting any path should produce a real HTTP response. Unknown routes
        // return 404, which still proves the listener is up.
        const res = await fetch(`http://127.0.0.1:${port}/__probe`);
        expect(res.status).toBeLessThan(600);
      }
    } finally {
      await mocks.stop();
    }
  }, 60_000);

  it("hits the Twilio mock route and gets a canned response", async () => {
    const mocks = await startMocks({ envs: ["twilio"] });
    try {
      const url = `${mocks.baseUrls.twilio}/2010-04-01/Accounts/ACtest/Messages.json`;
      const res = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({
          To: "+15551234567",
          From: "+15555550000",
          Body: "hello",
        }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        body: "hello",
        from: "+15555550000",
        sid: expect.stringMatching(/^SM[A-Za-z0-9]{32}$/),
        status: "queued",
        to: "+15551234567",
      });
    } finally {
      await mocks.stop();
    }
  }, 60_000);
});
