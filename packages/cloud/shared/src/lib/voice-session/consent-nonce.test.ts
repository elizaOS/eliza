import { expect, mock, test } from "bun:test";

const write = mock(async (_key: string) => {});
mock.module("../auth/authentication-state", () => ({
  buildAuthenticationState: () => ({ set: write }),
}));
mock.module("../cache/redis-factory", () => ({ isCloudflareWorkerRuntime: () => true }));
mock.module("../runtime/cloud-bindings", () => ({ getCloudAwareEnv: () => ({}) }));

const { issueConsentNonce } = await import("./consent-nonce");

test("warming observes the server nonce during storage and a write failure refuses consent", async () => {
  const pending = Promise.withResolvers<void>();
  write.mockImplementationOnce(() => pending.promise);
  let warmed: string | undefined;
  const issued = issueConsentNonce("owner", (nonce) => {
    warmed = nonce;
  });
  expect(warmed).toMatch(/^[0-9a-f-]{36}$/);
  expect(write.mock.calls.at(-1)?.[0]).toEndWith(`voice-session:consent:owner:${warmed}`);
  pending.reject(new Error("consent store unavailable"));
  await expect(issued).rejects.toThrow("consent store unavailable");
});

test("a failed advisory warm-up does not prevent issuance after the write succeeds", async () => {
  let warmed: string | undefined;
  const issued = await issueConsentNonce("owner", (nonce) => {
    warmed = nonce;
    throw new Error("warm-up unavailable");
  });
  expect(issued?.nonce).toBe(warmed);
  expect(issued?.expiresAt).toBeDefined();
});
