import { afterEach, expect, test, vi } from "vitest";

const { nativeRequest, sshRequest, registry } = vi.hoisted(() => ({
  nativeRequest: vi.fn(),
  sshRequest: vi.fn(),
  registry: {
    profiles: [
      { id: "first", connectionMode: "ssh", credentialRef: "credential-one" },
      { id: "second", connectionMode: "ssh", credentialRef: "credential-two" },
    ],
  },
}));
vi.mock("@capacitor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@capacitor/core")>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" },
  CapacitorHttp: { request: nativeRequest },
}));
vi.mock("../../../../ui/src/platform/ssh-runtime", () => ({
  requestSshRuntime: sshRequest,
}));
vi.mock("../../../../ui/src/state/agent-profiles", () => ({
  loadAgentProfileRegistry: () => registry,
}));

import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";
import { sshRuntimeTransportForUrl } from "./ssh-runtime-transport";

const cloudUrl = "https://api.eliza.app/api/test";
const sshUrl = "eliza-ssh://runtime/first/api/test";
const cloud = nativeCloudHttpTransportForUrl(cloudUrl);
const ssh = sshRuntimeTransportForUrl(sshUrl);
if (!cloud || !ssh) throw new Error("Expected native transports");
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
test.each([204, 205, 304])(
  "native Cloud and SSH accept bodyless status %s",
  async (status) => {
    nativeRequest.mockResolvedValueOnce({ status, data: "", headers: {} });
    sshRequest.mockResolvedValueOnce({ status, body: "" });
    expect((await cloud.request(cloudUrl, {})).body).toBeNull();
    expect((await ssh.request(sshUrl, {})).body).toBeNull();
  },
);
test("native Cloud preserves binary bytes and JSON error payloads", async () => {
  nativeRequest.mockResolvedValueOnce({
    status: 200,
    data: "AP+A",
    headers: {},
  });
  const response = await cloud.request(
    cloudUrl,
    {},
    { responseType: "arraybuffer" },
  );
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
    0, 255, 128,
  ]);
  nativeRequest.mockResolvedValueOnce({
    status: 403,
    data: { error: "denied" },
    headers: {},
  });
  expect(
    await (
      await cloud.request(cloudUrl, {}, { responseType: "arraybuffer" })
    ).json(),
  ).toEqual({ error: "denied" });
});
test("native Cloud preserves its fetch fallback for multipart uploads", async () => {
  const fetch = vi.fn(async () => new Response("uploaded"));
  vi.stubGlobal("fetch", fetch);
  const body = new FormData();
  body.set("field", "value");
  await cloud.request(cloudUrl, { method: "POST", body });
  expect(nativeRequest).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith(cloudUrl, { method: "POST", body });
});
test("native Cloud does not dispatch a cancelled operation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    cloud.request(cloudUrl, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(nativeRequest).not.toHaveBeenCalled();
});
test("SSH does not mix a captured runtime with another request URL", async () => {
  await expect(
    ssh.request("eliza-ssh://runtime/second/api/test", {}),
  ).rejects.toThrow("does not match");
  expect(sshRequest).not.toHaveBeenCalled();
});
