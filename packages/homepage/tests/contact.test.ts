/**
 * Tests homepage SMS contact link constants and href generation for the shared Eliza gateway.
 */

import { describe, expect, test } from "bun:test";
import {
  buildElizaDiscordHref,
  buildElizaSmsHref,
  buildElizaTelegramHref,
  buildElizaTelHref,
  buildElizaWhatsAppHref,
  canOpenElizaSmsLink,
  ELIZA_DISCORD_APPLICATION_ID,
  ELIZA_PHONE_NUMBER,
  ELIZA_TELEGRAM_BOT_ID,
  ELIZA_TELEGRAM_BOT_USERNAME,
  getDiscordBotApplicationId,
  getTelegramBotId,
  getWhatsAppNumber,
  openOrCopyElizaCall,
  openOrCopyElizaMessage,
  resolveWhatsAppNumber,
} from "../src/lib/contact";

describe("Eliza contact links", () => {
  test("builds an SMS link to the hosted Blooio number", () => {
    expect(ELIZA_PHONE_NUMBER).toBe("+18087881821");
    expect(buildElizaSmsHref()).toBe(
      `sms:${ELIZA_PHONE_NUMBER}?&body=Hey%20Eliza%2C%20what%20can%20you%20do%3F`,
    );
    expect(buildElizaSmsHref("hello")).toBe(
      `sms:${ELIZA_PHONE_NUMBER}?&body=hello`,
    );
    expect(buildElizaSmsHref()).not.toContain("14159611510");
    expect(buildElizaSmsHref()).not.toContain("4153024399");
    expect(buildElizaSmsHref()).not.toContain("415-302-4399");
  });

  test("builds a call link to the hosted Blooio number", () => {
    expect(buildElizaTelHref()).toBe(`tel:${ELIZA_PHONE_NUMBER}`);
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
    const discordUrl = new URL(buildElizaDiscordHref());
    expect(discordUrl.origin).toBe("https://discord.com");
    expect(discordUrl.pathname).toBe("/oauth2/authorize");
    expect(discordUrl.searchParams.get("client_id")).toBe(
      ELIZA_DISCORD_APPLICATION_ID,
    );
    expect(discordUrl.searchParams.get("integration_type")).toBe("1");
    expect(discordUrl.searchParams.get("scope")).toBe("applications.commands");
    expect(getTelegramBotId()).toBe(ELIZA_TELEGRAM_BOT_ID);
    expect(getDiscordBotApplicationId()).toBe(ELIZA_DISCORD_APPLICATION_ID);
  });

  test("opens the native SMS handler only on supported platforms", async () => {
    for (const platform of ["iPhone", "iPad", "MacIntel", "Android"]) {
      expect(canOpenElizaSmsLink({ platform })).toBe(true);
    }
    expect(canOpenElizaSmsLink({ platform: "Win32" })).toBe(false);
    expect(canOpenElizaSmsLink({ platform: "Linux x86_64" })).toBe(false);

    const location = { href: "https://eliza.app/" };
    const clipboardWrites: string[] = [];
    await expect(
      openOrCopyElizaMessage({
        location,
        navigator: {
          platform: "MacIntel",
          clipboard: {
            writeText: async (value) => {
              clipboardWrites.push(value);
            },
          },
        },
      }),
    ).resolves.toBe("handoff");
    expect(location.href).toBe(buildElizaSmsHref());
    expect(clipboardWrites).toEqual([]);
  });

  test("copies the sender on unsupported platforms and fails visibly without a clipboard", async () => {
    const clipboardWrites: string[] = [];
    await expect(
      openOrCopyElizaMessage({
        location: { href: "https://eliza.app/" },
        navigator: {
          platform: "Win32",
          clipboard: {
            writeText: async (value) => {
              clipboardWrites.push(value);
            },
          },
        },
      }),
    ).resolves.toBe("copied");
    expect(clipboardWrites).toEqual([ELIZA_PHONE_NUMBER]);

    await expect(
      openOrCopyElizaMessage({
        location: { href: "https://eliza.app/" },
        navigator: { platform: "Linux x86_64" },
      }),
    ).rejects.toThrow("Clipboard access is unavailable");
  });

  test("opens native calling when supported and copies the number otherwise", async () => {
    const nativeLocation = { href: "https://eliza.app/" };
    await expect(
      openOrCopyElizaCall({
        location: nativeLocation,
        navigator: { platform: "MacIntel" },
      }),
    ).resolves.toBe("handoff");
    expect(nativeLocation.href).toBe(buildElizaTelHref());

    const clipboardWrites: string[] = [];
    await expect(
      openOrCopyElizaCall({
        location: { href: "https://eliza.app/" },
        navigator: {
          platform: "Win32",
          clipboard: {
            writeText: async (value) => clipboardWrites.push(value),
          },
        },
      }),
    ).resolves.toBe("copied");
    expect(clipboardWrites).toEqual([ELIZA_PHONE_NUMBER]);

    await expect(
      openOrCopyElizaCall({
        location: { href: "https://eliza.app/" },
        navigator: { platform: "Linux x86_64" },
      }),
    ).rejects.toThrow("Clipboard access is unavailable");
  });
});
