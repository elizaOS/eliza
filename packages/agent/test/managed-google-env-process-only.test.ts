import { expect, it } from "vitest";
import {
  isBlockedEnvKey,
  isProcessOnlyEnvKey,
} from "../src/config/blocked-env-keys.ts";
import {
  buildRuntimeSettingsProjection,
  isEnvKeyAllowedForForwarding,
} from "../src/runtime/runtime-settings.ts";

it("keeps private Google host endpoints and enablement flags out of config writes", () => {
  for (const key of [
    "ELIZA_MANAGED_GMAIL_READ_BROKER",
    "ELIZA_MANAGED_GMAIL_SEND_BROKER",
    "ELIZA_MANAGED_GMAIL_OPERATION_BROKER",
    "ELIZA_MANAGED_GMAIL_MAILBOX_CHANGES_ENABLED",
    "ELIZA_MANAGED_CALENDAR_READ_BROKER",
    "ELIZA_MANAGED_CALENDAR_DELETE_ENABLED",
    "ELIZA_NATIVE_GOOGLE_HOST_MODULE",
    "ELIZA_NATIVE_GOOGLE_BINDING_JSON",
    "ELIZA_NATIVE_GOOGLE_API_KEY",
    "ELIZA_NATIVE_GOOGLE_GMAIL_SEND_ENABLED",
  ]) {
    expect(isProcessOnlyEnvKey(key)).toBe(true);
    expect(isBlockedEnvKey(key)).toBe(true);
  }
  expect(isBlockedEnvKey("ELIZA_MANAGED_EVM_ADDRESS")).toBe(false);
});

it("keeps the native Google service credential out of generic runtime settings", () => {
  expect(isEnvKeyAllowedForForwarding("ELIZA_NATIVE_GOOGLE_API_KEY")).toBe(
    false,
  );
  expect(isEnvKeyAllowedForForwarding("CEREBRAS_API_KEY")).toBe(true);
  expect(isEnvKeyAllowedForForwarding("CARTESIA_API_KEY")).toBe(true);
  const settings = buildRuntimeSettingsProjection(
    {},
    {
      env: {
        ELIZA_NATIVE_GOOGLE_API_KEY: "private-service-key",
        CEREBRAS_API_KEY: "inference-key",
        CARTESIA_API_KEY: "voice-key",
      },
    },
  );
  expect(settings).not.toHaveProperty("ELIZA_NATIVE_GOOGLE_API_KEY");
});
