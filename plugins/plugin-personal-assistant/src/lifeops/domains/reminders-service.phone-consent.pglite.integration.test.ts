/** Phone consent canonical keys and primary selection against the real repository. */
import { TaskService } from "@elizaos/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import { createLifeOpsChannelPolicy } from "../repository.js";
import { LifeOpsService } from "../service.js";
import { normalizePhoneNumber } from "../service-normalize.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;

beforeAll(async () => {
  vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
});

it.each([
  ["5551234567", "+15551234567"],
  ["(555) 123-4567", "+15551234567"],
  ["555.123.4567", "+15551234567"],
  ["15551234567", "+15551234567"],
  ["+1 (555) 123-4567", "+15551234567"],
  ["442079460958", "+442079460958"],
  ["+44 20 7946 0958", "+442079460958"],
  ["+298123456", "+298123456"],
])("normalizes %s to %s", (input, expected) => {
  expect(normalizePhoneNumber(input, "phoneNumber")).toBe(expected);
});

it.each([
  "5551234",
  "0400123456",
  "07911123456",
  "1555123456",
  "+0123456789",
  "555-CALL-1234",
  "++15551234567",
  "+1234567890123456",
])("asks for the country code instead of guessing for %s", (input) => {
  expect(() => normalizePhoneNumber(input, "phoneNumber")).toThrow(
    "phoneNumber must be a phone number with its country code, for example +15551234567",
  );
});

it("selects the newly consented number over a policy stored under the previous key", async () => {
  const agentId = fixture.runtime.agentId;
  for (const channelType of ["sms", "voice"] as const) {
    await service.repository.upsertChannelPolicy(
      createLifeOpsChannelPolicy({
        agentId,
        channelType,
        channelRef: "+5551234567",
        privacyClass: "private",
        allowReminders: false,
        allowEscalation: false,
        allowPosts: false,
        requireConfirmationForActions: true,
        metadata: { isPrimary: true, phoneNumber: "+5551234567" },
      }),
    );
  }
  expect((await service.resolvePrimaryChannelPolicy("sms"))?.channelRef).toBe(
    "+5551234567",
  );

  const consent = await service.capturePhoneConsent({
    phoneNumber: "5551234567",
    consentGiven: true,
    allowSms: true,
    allowVoice: true,
  });
  expect(consent.phoneNumber).toBe("+15551234567");

  for (const channelType of ["sms", "voice"] as const) {
    const selected = await service.resolvePrimaryChannelPolicy(channelType);
    expect(selected).toMatchObject({
      channelRef: "+15551234567",
      allowReminders: true,
      allowEscalation: true,
    });
  }
  const phonePolicies = (await service.listChannelPolicies()).filter(
    (policy) => policy.channelType === "sms" || policy.channelType === "voice",
  );
  expect(
    phonePolicies
      .filter((policy) => policy.metadata.isPrimary === true)
      .map((policy) => `${policy.channelType} ${policy.channelRef}`)
      .sort(),
  ).toEqual(["sms +15551234567", "voice +15551234567"]);
  expect(
    phonePolicies
      .filter((policy) => policy.channelRef === "+5551234567")
      .map((policy) => policy.allowReminders),
  ).toEqual([false, false]);
});

it("leaves the primary phone policy in place when the consent request is rejected", async () => {
  await service.repository.upsertChannelPolicy({
    ...createLifeOpsChannelPolicy({
      agentId: fixture.runtime.agentId,
      channelType: "sms",
      channelRef: "+15550000001",
      privacyClass: "private",
      allowReminders: true,
      allowEscalation: false,
      allowPosts: false,
      requireConfirmationForActions: true,
      metadata: {},
    }),
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  await service.capturePhoneConsent({
    phoneNumber: "+15557654321",
    consentGiven: true,
    allowSms: true,
    allowVoice: true,
  });

  await expect(
    service.capturePhoneConsent({
      phoneNumber: "+15558889999",
      consentGiven: true,
      allowSms: "yes" as unknown as boolean,
      allowVoice: true,
    }),
  ).rejects.toThrow("allowSms must be a boolean");

  expect((await service.resolvePrimaryChannelPolicy("sms"))?.channelRef).toBe(
    "+15557654321",
  );
});
