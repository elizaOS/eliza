/** Verifies Android Gradle patches leave the tracked in-tree Gradle files unchanged. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  applyConsumerIdentityExt,
  injectBuildConfigAospField,
} from "./gradle-patches.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const trackedAppGradlePath = path.resolve(
  here,
  "../../../platforms/android/app/build.gradle",
);

const trackedVariablesGradlePath = path.resolve(
  here,
  "../../../platforms/android/variables.gradle",
);

describe("injectBuildConfigAospField", () => {
  it("leaves the tracked in-tree app/build.gradle unchanged", () => {
    const tracked = fs.readFileSync(trackedAppGradlePath, "utf8");
    expect(injectBuildConfigAospField(tracked)).toBe(tracked);
  });
});

describe("applyConsumerIdentityExt", () => {
  const canonical = { appId: "ai.elizaos.app", namespace: "ai.elizaos.app" };

  it("leaves the tracked in-tree variables.gradle unchanged", () => {
    const tracked = fs.readFileSync(trackedVariablesGradlePath, "utf8");
    expect(applyConsumerIdentityExt(tracked, canonical)).toBe(tracked);
  });

  it("writes a consumer identity once into the ext block", () => {
    const identity = { appId: "com.example.app", namespace: "com.example.app" };
    const line =
      "    consumerIdentity = [appId: 'com.example.app', namespace: 'com.example.app']";
    const added = applyConsumerIdentityExt(
      "ext {\n    minSdkVersion = 26\n}\n",
      identity,
    );
    expect(added).toBe(`ext {\n${line}\n    minSdkVersion = 26\n}\n`);
    const tracked = fs.readFileSync(trackedVariablesGradlePath, "utf8");
    const replaced = applyConsumerIdentityExt(tracked, identity);
    expect(replaced.split("consumerIdentity").length).toBe(2);
    expect(replaced).toContain(line);
    expect(applyConsumerIdentityExt(replaced, identity)).toBe(replaced);
  });

  it("rejects a value that is not an Android package name", () => {
    expect(() =>
      applyConsumerIdentityExt("ext {\n}\n", {
        appId: "com.example'] + evil",
        namespace: "com.example",
      }),
    ).toThrow(/Invalid Android package name/);
  });
});
