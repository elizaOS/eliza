import { afterEach, expect, it } from "vitest";
import {
  type StartedMocks,
  startMocks,
} from "../../scripts/mocks/start-mocks.ts";
import {
  createMockEffectCapture,
  createRemoteMockEffectCapture,
} from "./effect-observation.ts";
import { parseSyntheticWorldConfiguration } from "./synthetic-world-settings.ts";

let mocks: StartedMocks | undefined;
afterEach(async () => {
  await mocks?.stop();
  mocks = undefined;
});
it("observes actual API writes through local and remote mock evidence", async () => {
  mocks = await startMocks({ envs: ["slack"] });
  const local = createMockEffectCapture(mocks);
  const remote = createRemoteMockEffectCapture({ slack: mocks.baseUrls.slack });
  const clean = await local();
  expect(await clean()).toEqual([]);
  const localEnd = await local();
  const remoteEnd = await remote();
  const response = await fetch(`${mocks.baseUrls.slack}/api/chat.postMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "C001", text: "complete effect" }),
  });
  expect(response.ok).toBe(true);
  await response.arrayBuffer();
  expect(await localEnd()).toContain("slack: POST /api/chat.postMessage");
  expect(await remoteEnd()).toEqual(["slack: POST /api/chat.postMessage"]);
  const resetEnd = await remote();
  mocks.clearRequestLedger();
  await expect(resetEnd()).rejects.toMatchObject({
    code: "SCENARIO_EFFECT_EVIDENCE_RESET",
  });
});
it("reports malformed serialized world endpoints with the typed boundary error", () => {
  expect(() => parseSyntheticWorldConfiguration("{malformed")).toThrow(
    expect.objectContaining({ code: "SYNTHETIC_WORLD_ENDPOINT_INVALID" }),
  );
  expect(
    parseSyntheticWorldConfiguration('{"slack":"http://127.0.0.1:1234"}')
      .endpoints.slack,
  ).toBe("http://127.0.0.1:1234");
});
