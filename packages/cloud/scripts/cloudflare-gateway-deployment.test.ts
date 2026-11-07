import { expect, test } from "bun:test";
import { verifiedGatewayDeployment } from "./cloudflare-gateway-deployment";

const current = {
  service: "eliza-gateway-webhook-staging",
  versionId: "version-selected",
  deploymentId: "deployment-selected",
  image: "image-old",
};
const expected = { versionId: current.versionId, image: "image-new" };

test("waits only for the selected deployment's stale image to converge", async () => {
  let reads = 0,
    clock = 0;
  const result = await verifiedGatewayDeployment("staging", expected, {
    read: async (_environment, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      reads++;
      return { ...current, image: reads === 1 ? "image-old" : "image-new" };
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    timeoutMs: 100,
    intervalMs: 10,
  });
  expect(result.image).toBe("image-new");
  expect(reads).toBe(2);
  expect(clock).toBe(10);
});

for (const change of [
  { versionId: "another-version" },
  { deploymentId: "another-deployment" },
]) {
  test(`fails when ${Object.keys(change)[0]} changes, even if the image converges`, async () => {
    let reads = 0,
      clock = 0;
    await expect(
      verifiedGatewayDeployment("staging", expected, {
        read: async () =>
          ++reads === 1
            ? current
            : { ...current, ...change, image: "image-new" },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        timeoutMs: 100,
        intervalMs: 10,
      }),
    ).rejects.toThrow(/gateway version|deployment identity/);
    expect(reads).toBe(2);
  });
}

test("finite nonconvergence stops without accepting or resetting the deadline", async () => {
  let reads = 0,
    clock = 0;
  await expect(
    verifiedGatewayDeployment("staging", expected, {
      read: async () => {
        reads++;
        return current;
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      timeoutMs: 20,
      intervalMs: 10,
    }),
  ).rejects.toThrow("before the deadline");
  expect(reads).toBe(2);
  expect(clock).toBe(20);
});

test("lookup errors and unselected image mismatches are never retried", async () => {
  let reads = 0;
  await expect(
    verifiedGatewayDeployment("staging", expected, {
      read: async () => {
        reads++;
        throw Error("HTTP 403");
      },
    }),
  ).rejects.toThrow("HTTP 403");
  expect(reads).toBe(1);
  await expect(
    verifiedGatewayDeployment(
      "staging",
      { image: "image-new" },
      {
        read: async () => {
          reads++;
          return current;
        },
      },
    ),
  ).rejects.toThrow("image is no longer configured");
  expect(reads).toBe(2);
});
