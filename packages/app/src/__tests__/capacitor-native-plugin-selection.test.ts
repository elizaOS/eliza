/** Exercises Android plugin selection so renamed bridges survive Capacitor sync and Firebase exclusions remain scoped. */
import { describe, expect, it } from "vitest";
import { resolveAndroidCapacitorPlugins } from "../../capacitor.config";

describe("Android Capacitor plugin selection", () => {
  const dependencies = {
    "@elizaos/plugin-native-phone": "workspace:*",
    "@elizaos/plugin-native-messages": "workspace:*",
    "@elizaos/plugin-native-contacts": "workspace:*",
    "@elizaos/plugin-native-inference": "workspace:*",
    "@elizaos/plugin-native-wifi": "workspace:*",
    "@elizaos/capacitor-location": "workspace:*",
    "@capacitor/app": "8.1.1",
    "@capacitor/push-notifications": "8.1.2",
    "@capacitor/core": "8.3.1",
    "@capacitor/android": "8.3.1",
    "@capacitor/ios": "8.3.1",
    "@elizaos/core": "workspace:*",
  };

  it("keeps renamed native bridges alongside existing plugins, excluding runtimes", () => {
    const plugins = resolveAndroidCapacitorPlugins(dependencies);
    for (const name of Object.keys(dependencies)) {
      const runtime = [
        "@capacitor/core",
        "@capacitor/android",
        "@capacitor/ios",
        "@elizaos/core",
      ].includes(name);
      expect(plugins.includes(name), name).toBe(!runtime);
    }
  });

  it("omits only Firebase push from the remote fallback selection", () => {
    expect(resolveAndroidCapacitorPlugins(dependencies, true)).toEqual(
      resolveAndroidCapacitorPlugins(dependencies).filter(
        (name) => name !== "@capacitor/push-notifications",
      ),
    );
  });
});
