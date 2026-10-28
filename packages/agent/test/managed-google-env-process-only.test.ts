import { expect, it } from "vitest";
import {
  isBlockedEnvKey,
  isProcessOnlyEnvKey,
} from "../src/config/blocked-env-keys.ts";

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
    "ELIZA_NATIVE_GOOGLE_GMAIL_SEND_ENABLED",
  ]) {
    expect(isProcessOnlyEnvKey(key)).toBe(true);
    expect(isBlockedEnvKey(key)).toBe(true);
  }
  expect(isBlockedEnvKey("ELIZA_MANAGED_EVM_ADDRESS")).toBe(false);
});
