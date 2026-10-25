/** Verifies Android Gradle patches keep env-provided SMS gateway values out of build.gradle. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  androidSmsGatewayBuildConfigFieldLines,
  injectAndroidSmsGatewayBuildConfigFields,
} from "./gradle-patches.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const trackedAppGradlePath = path.resolve(
  here,
  "../../../platforms/android/app/build.gradle",
);

const STRING_FIELDS = [
  "ELIZA_ANDROID_SMS_GATEWAY_SECRET",
  "ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL",
  "ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER",
  "ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL",
];

const SENTINEL_SECRET = "sms-gateway-secret-sentinel-3f9c";

const MINIMAL_GRADLE = `android {
    defaultConfig {
        applicationId "ai.elizaos.app"
    }
}
`;

describe("injectAndroidSmsGatewayBuildConfigFields", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of STRING_FIELDS) saved.set(name, process.env[name]);
    process.env.ELIZA_ANDROID_SMS_GATEWAY_SECRET = SENTINEL_SECRET;
    process.env.ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL =
      "https://sentinel.invalid/hook";
    process.env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER = "+15550000000";
    process.env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL = "Sentinel Label";
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("never writes the resolved env values into build.gradle", () => {
    const patched = injectAndroidSmsGatewayBuildConfigFields(MINIMAL_GRADLE);
    expect(patched).not.toContain(SENTINEL_SECRET);
    expect(patched).not.toContain("https://sentinel.invalid/hook");
    expect(patched).not.toContain("+15550000000");
    expect(patched).not.toContain("Sentinel Label");
  });

  it("reads every String field from the environment at Gradle time", () => {
    const lines = androidSmsGatewayBuildConfigFieldLines();
    for (const name of STRING_FIELDS) {
      const line = lines.find((l) => l.includes(`"${name}"`));
      expect(line, name).toBeDefined();
      expect(line).toContain(`buildConfigField "String", "${name}"`);
      expect(line).toContain(`System.getenv('${name}')`);
    }
    const secretLine = lines.find((l) =>
      l.includes('"ELIZA_ANDROID_SMS_GATEWAY_SECRET"'),
    );
    expect(secretLine).toContain(
      "System.getenv('ELIZA_ANDROID_SMS_GATEWAY_SECRET') ?: ''",
    );
  });

  it("escapes backslash, quote and control characters for the Java literal", () => {
    // A newline or other control character in an env value must become a Java
    // octal escape; escaping only `\` and `"` emits an unterminated literal.
    const escapeExpr = String.raw`.collect { ch -> ch == '\\' ? '\\\\' : ch == '"' ? '\\"' : (ch.codePointAt(0) < 32 || ch.codePointAt(0) == 127) ? String.format('\\%03o', ch.codePointAt(0)) : ch }.join('')`;
    for (const name of STRING_FIELDS) {
      const line = androidSmsGatewayBuildConfigFieldLines().find((l) =>
        l.includes(`"${name}"`),
      );
      expect(line, name).toContain(escapeExpr);
      expect(line, name).not.toContain(".replace(");
    }
  });

  it("is output-independent of the build env and idempotent", () => {
    const withEnv = injectAndroidSmsGatewayBuildConfigFields(MINIMAL_GRADLE);
    for (const name of STRING_FIELDS) delete process.env[name];
    const withoutEnv = injectAndroidSmsGatewayBuildConfigFields(MINIMAL_GRADLE);
    expect(withEnv).toBe(withoutEnv);
    expect(injectAndroidSmsGatewayBuildConfigFields(withEnv)).toBe(withEnv);
  });

  it("leaves the tracked in-tree app/build.gradle unchanged", () => {
    const tracked = fs.readFileSync(trackedAppGradlePath, "utf8");
    expect(injectAndroidSmsGatewayBuildConfigFields(tracked)).toBe(tracked);
  });
});
