/**
 * Fail-closed browser fallback. A web page has no Keystore, Autofill service or system
 * authentication prompt, so the vault is reported unavailable rather than emulated with
 * script-readable storage.
 */
import { WebPlugin } from "@capacitor/core";
import type { ElizaPasswordsPlugin, PasswordsStatus } from "./definitions";

const unavailable = () =>
  Object.assign(
    new Error("Saved passwords are available only in the native app."),
    {
      code: "unavailable",
    },
  );

export class ElizaPasswordsWeb
  extends WebPlugin
  implements ElizaPasswordsPlugin
{
  async status(): Promise<PasswordsStatus> {
    return {
      available: false,
      reason: "unsupported",
      locked: true,
      unlockRemainingMs: 0,
      unlockSeconds: 0,
      biometric: false,
      autofill: { supported: null, selected: "unknown" },
    };
  }
  async unlock(): Promise<never> {
    throw unavailable();
  }
  async lock(): Promise<{ locked: true }> {
    return { locked: true };
  }
  async list(): Promise<never> {
    throw unavailable();
  }
  async save(): Promise<never> {
    throw unavailable();
  }
  async remove(): Promise<never> {
    throw unavailable();
  }
  async reset(): Promise<never> {
    throw unavailable();
  }
  async reveal(): Promise<never> {
    throw unavailable();
  }
  async copy(): Promise<never> {
    throw unavailable();
  }
  async openAutofillSettings(): Promise<never> {
    throw unavailable();
  }
}
