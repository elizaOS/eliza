import assert from "node:assert/strict";
import test from "node:test";
import { createCloudRoutes } from "./cloud-runtime-routes.mjs";

function fixture(overrides = {}) {
  let owner = "owner",
    calls = 0;
  const documentRuntime = {
    resolveCloudSdkAuthorityTuple: (runtime) => ({
      outboundAllowed: true,
      apiKey: runtime.getSetting("ELIZAOS_CLOUD_API_KEY"),
      apiBaseUrl: runtime.getSetting("ELIZAOS_CLOUD_BASE_URL"),
    }),
    getNativeApplicationSlot: () => undefined,
    getAppId: () => undefined,
    handleImageDescription: async (runtime, params) => {
      calls++;
      assert.equal(runtime.getSetting("ELIZAOS_CLOUD_API_KEY"), "host-secret");
      assert.equal(
        runtime.getSetting("ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL"),
        "test-vision",
      );
      return { title: "test", description: params.prompt };
    },
    ...overrides,
  };
  const cloud = createCloudRoutes({
    initialApiKey: "host-secret",
    credentialGate: async () => owner,
  });
  return {
    describe: cloud.documentImagesForAccount({
      actorId: "owner",
      model: "test-vision",
      documentRuntime,
    }),
    change: () => (owner = "other"),
    calls: () => calls,
  };
}
test("document model uses bound host authority and rejects ambient routing overrides", async () => {
  const f = fixture();
  assert.deepEqual(await f.describe({ prompt: "fixture" }), {
    title: "test",
    description: "fixture",
  });
  assert.equal(f.calls(), 1);
  for (const overrides of [
    {
      resolveCloudSdkAuthorityTuple: () => ({
        outboundAllowed: true,
        apiKey: "other",
        apiBaseUrl: "https://api.eliza.app/api/v1",
      }),
    },
    { getNativeApplicationSlot: () => "another-product" },
    { getAppId: () => "another-app" },
  ]) {
    const invalid = fixture(overrides);
    await assert.rejects(invalid.describe({ prompt: "fixture" }));
    assert.equal(invalid.calls(), 0);
  }
});
test("document inference cannot start or publish after owner change", async () => {
  const before = fixture();
  before.change();
  await assert.rejects(before.describe({ prompt: "fixture" }));
  assert.equal(before.calls(), 0);
  let started, release;
  const began = new Promise((r) => (started = r)),
    wait = new Promise((r) => (release = r));
  const pending = fixture({
    handleImageDescription: async () => {
      started();
      await wait;
      return { description: "late" };
    },
  });
  const result = pending.describe({ prompt: "fixture" });
  await began;
  pending.change();
  release();
  await assert.rejects(result, /account changed/);
});
test("cancelled document inference never dispatches", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.describe({ prompt: "fixture", signal: controller.signal }),
  );
  assert.equal(f.calls(), 0);
});
