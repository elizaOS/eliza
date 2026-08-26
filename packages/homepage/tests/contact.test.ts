/**
 * Tests homepage contact link constants, href generation, and Discord
 * environment fail-closed resolution for the shared Eliza gateway.
 */

import { describe, expect, test } from "bun:test";
import {
  buildElizaDiscordHref,
  buildElizaDiscordHrefForApplicationId,
  buildElizaSmsHref,
  buildElizaTelegramHref,
  buildElizaTelHref,
  buildElizaWhatsAppHref,
  canOpenElizaSmsLink,
  DISCORD_APPLICATION_SNOWFLAKE_ERROR,
  ELIZA_DISCORD_APPLICATION_ID,
  ELIZA_PHONE_NUMBER,
  ELIZA_TELEGRAM_BOT_ID,
  ELIZA_TELEGRAM_BOT_USERNAME,
  getDiscordBotApplicationId,
  getTelegramBotId,
  getWhatsAppNumber,
  openOrCopyElizaCall,
  openOrCopyElizaMessage,
  PRODUCTION_DISCORD_CANONICAL_ERROR,
  resolveDiscordApplicationId,
  resolveWhatsAppNumber,
  STAGING_DISCORD_PRODUCTION_COLLISION_ERROR,
  STAGING_DISCORD_REQUIRED_ERROR,
} from "../src/lib/contact";

const STAGING_DISCORD_APPLICATION_ID = "1111111111111111111";

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

  test("builds environment-specific Discord OAuth URLs from the resolved application", () => {
    const stagingHref = buildElizaDiscordHrefForApplicationId(
      resolveDiscordApplicationId(STAGING_DISCORD_APPLICATION_ID, "staging"),
    );
    const productionHref = buildElizaDiscordHrefForApplicationId(
      resolveDiscordApplicationId(undefined, "production"),
    );
    const stagingUrl = new URL(stagingHref);
    const productionUrl = new URL(productionHref);

    expect(stagingUrl.searchParams.get("client_id")).toBe(
      STAGING_DISCORD_APPLICATION_ID,
    );
    expect(productionUrl.searchParams.get("client_id")).toBe(
      ELIZA_DISCORD_APPLICATION_ID,
    );
    expect(stagingHref).not.toContain(ELIZA_DISCORD_APPLICATION_ID);
    expect(productionHref).not.toContain(STAGING_DISCORD_APPLICATION_ID);
    expect(stagingUrl.searchParams.get("integration_type")).toBe("1");
    expect(stagingUrl.searchParams.get("scope")).toBe("applications.commands");
  });

  test("rejects a missing, blank, malformed, or production Discord id on staging", () => {
    expect(() => resolveDiscordApplicationId(undefined, "staging")).toThrow(
      STAGING_DISCORD_REQUIRED_ERROR,
    );
    expect(() => resolveDiscordApplicationId("", "staging")).toThrow(
      STAGING_DISCORD_REQUIRED_ERROR,
    );
    expect(() => resolveDiscordApplicationId("   ", "staging")).toThrow(
      STAGING_DISCORD_REQUIRED_ERROR,
    );
    expect(() =>
      resolveDiscordApplicationId("not-a-snowflake", "staging"),
    ).toThrow(STAGING_DISCORD_REQUIRED_ERROR);
    expect(() => resolveDiscordApplicationId("12345", "staging")).toThrow(
      STAGING_DISCORD_REQUIRED_ERROR,
    );
    expect(() =>
      resolveDiscordApplicationId(ELIZA_DISCORD_APPLICATION_ID, "staging"),
    ).toThrow(STAGING_DISCORD_PRODUCTION_COLLISION_ERROR);
    expect(
      resolveDiscordApplicationId(STAGING_DISCORD_APPLICATION_ID, "staging"),
    ).toBe(STAGING_DISCORD_APPLICATION_ID);
  });

  test("keeps production on the canonical Discord application", () => {
    expect(resolveDiscordApplicationId(undefined, "production")).toBe(
      ELIZA_DISCORD_APPLICATION_ID,
    );
    expect(
      resolveDiscordApplicationId(ELIZA_DISCORD_APPLICATION_ID, "production"),
    ).toBe(ELIZA_DISCORD_APPLICATION_ID);
    expect(() =>
      resolveDiscordApplicationId("not-a-snowflake", "production"),
    ).toThrow(DISCORD_APPLICATION_SNOWFLAKE_ERROR);
    expect(() =>
      resolveDiscordApplicationId(STAGING_DISCORD_APPLICATION_ID, "production"),
    ).toThrow(PRODUCTION_DISCORD_CANONICAL_ERROR);
  });

  test("allows a local Discord override without using the staging production fallback", () => {
    expect(resolveDiscordApplicationId(undefined, undefined)).toBe(
      ELIZA_DISCORD_APPLICATION_ID,
    );
    expect(
      resolveDiscordApplicationId(STAGING_DISCORD_APPLICATION_ID, undefined),
    ).toBe(STAGING_DISCORD_APPLICATION_ID);
    expect(() =>
      resolveDiscordApplicationId("not-a-snowflake", undefined),
    ).toThrow(DISCORD_APPLICATION_SNOWFLAKE_ERROR);
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
