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

describe("Eliza contact edge behaviour", () => {
  test("falls back to the default WhatsApp sender outside production when config is absent or invalid", () => {
    expect(resolveWhatsAppNumber(undefined, false)).toBe("+14159611510");
    expect(resolveWhatsAppNumber("not-a-phone", false)).toBe("+14159611510");
    expect(resolveWhatsAppNumber("+15551234567", false)).toBe("+15551234567");
  });

  test("normalizes configured E.164 senders with strict digit boundaries", () => {
    expect(resolveWhatsAppNumber("  +15551234567  ", true)).toBe(
      "+15551234567",
    );
    expect(resolveWhatsAppNumber("+12345678", true)).toBe("+12345678");
    expect(resolveWhatsAppNumber("+1234567", true)).toBeNull();
    expect(resolveWhatsAppNumber("+02345678", true)).toBeNull();
    expect(resolveWhatsAppNumber("+123456789012345", true)).toBe(
      "+123456789012345",
    );
    expect(resolveWhatsAppNumber("+1234567890123456", true)).toBeNull();
  });

  test("prefers userAgentData.platform and falls back to the userAgent string for native links", () => {
    expect(
      canOpenElizaSmsLink({
        platform: "Win32",
        userAgentData: { platform: "iPad" },
      }),
    ).toBe(true);
    expect(
      canOpenElizaSmsLink({
        platform: "iPad",
        userAgentData: { platform: "Windows" },
      }),
    ).toBe(false);
    expect(
      canOpenElizaSmsLink({
        platform: "",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe(true);
    expect(canOpenElizaSmsLink({ platform: "", userAgent: "iPod touch" })).toBe(
      true,
    );
    expect(canOpenElizaSmsLink({ platform: "", userAgent: "" })).toBe(false);
  });

  test("hands off custom SMS messages through a lossless percent-encoded href", async () => {
    const message = "call me & stay weird 🤖 100%";
    const location = { href: "https://eliza.app/" };
    await expect(
      openOrCopyElizaMessage(
        { location, navigator: { platform: "MacIntel" } },
        message,
      ),
    ).resolves.toBe("handoff");
    expect(location.href).toBe(buildElizaSmsHref(message));
    const encoded = location.href.split("&body=")[1];
    expect(encoded).toBeDefined();
    expect(decodeURIComponent(encoded ?? "")).toBe(message);
  });

  test("percent-encodes URL-significant characters in SMS bodies", () => {
    expect(buildElizaSmsHref("a&b=c d?e#f/g:h")).toBe(
      "sms:+18087881821?&body=a%26b%3Dc%20d%3Fe%23f%2Fg%3Ah",
    );
  });
});
