/**
 * Tests homepage SMS contact link constants and href generation for the shared Eliza gateway.
 */

import { describe, expect, test } from "bun:test";
import {
  buildElizaDiscordHref,
  buildElizaSmsHref,
  buildElizaTelegramHref,
  buildElizaWhatsAppHref,
  ELIZA_DISCORD_APPLICATION_ID,
  ELIZA_PHONE_FORMATTED,
  ELIZA_PHONE_NUMBER,
  ELIZA_TELEGRAM_BOT_ID,
  ELIZA_TELEGRAM_BOT_USERNAME,
  getDiscordBotApplicationId,
  getTelegramBotId,
  getWhatsAppNumber,
  resolveWhatsAppNumber,
} from "../src/lib/contact";

describe("Eliza contact links", () => {
  test("builds an SMS link to the hosted Blooio number", () => {
    expect(ELIZA_PHONE_NUMBER).toBe("+18087881821");
    expect(ELIZA_PHONE_FORMATTED).toBe("+1 (808) 788-1821");
    expect(buildElizaSmsHref("Hi Eliza")).toBe(
      `sms:${ELIZA_PHONE_NUMBER}?&body=Hi%20Eliza`,
    );
    expect(buildElizaSmsHref()).not.toContain("14159611510");
    expect(buildElizaSmsHref()).not.toContain("4153024399");
    expect(buildElizaSmsHref()).not.toContain("415-302-4399");
  });

  test("keeps the WhatsApp fallback separate from the Blooio number", () => {
    expect(getWhatsAppNumber()).toBe("+14159611510");
  });

  test("fails closed when a production WhatsApp sender is absent or invalid", () => {
    expect(resolveWhatsAppNumber(undefined, true)).toBeNull();
    expect(resolveWhatsAppNumber("14159611510", true)).toBeNull();
    expect(resolveWhatsAppNumber("+15551234567", true)).toBe("+15551234567");
  });

  test("builds direct web links for every supported messaging channel", () => {
    expect(buildElizaWhatsAppHref()).toMatch(/^https:\/\/wa\.me\/\d+$/);
    expect(buildElizaTelegramHref()).toBe(
      `https://t.me/${ELIZA_TELEGRAM_BOT_USERNAME}`,
    );
    expect(buildElizaDiscordHref()).toBe(
      `https://discord.com/users/${ELIZA_DISCORD_APPLICATION_ID}`,
    );
    expect(getTelegramBotId()).toBe(ELIZA_TELEGRAM_BOT_ID);
    expect(getDiscordBotApplicationId()).toBe(ELIZA_DISCORD_APPLICATION_ID);
  });
});
