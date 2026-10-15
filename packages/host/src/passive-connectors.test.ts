import { describe, expect, it } from "vitest";
import {
  lifeOpsPassiveConnectorsEnabled,
  lifeOpsPassiveConnectorsSetting,
} from "./passive-connectors.js";

function runtimeWith(
  settings: Record<string, unknown>,
  plugins: Array<{ name: string; passiveConnectorsByDefault?: boolean }> = [],
) {
  return {
    getSetting: (key: string) => settings[key],
    plugins,
  };
}

describe("lifeOpsPassiveConnectorsSetting", () => {
  it("returns undefined when nothing is configured", () => {
    expect(lifeOpsPassiveConnectorsSetting(null, {})).toBeUndefined();
  });

  it("treats blank or whitespace env values as unconfigured", () => {
    expect(
      lifeOpsPassiveConnectorsSetting(null, {
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "",
        LIFEOPS_PASSIVE_CONNECTORS: "   ",
      }),
    ).toBeUndefined();
  });

  it("falls through a blank ELIZA_ key to a set LIFEOPS_ key", () => {
    expect(
      lifeOpsPassiveConnectorsSetting(null, {
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "",
        LIFEOPS_PASSIVE_CONNECTORS: "false",
      }),
    ).toBe(false);
    expect(
      lifeOpsPassiveConnectorsSetting(null, {
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: " ",
        LIFEOPS_PASSIVE_CONNECTORS: "true",
      }),
    ).toBe(true);
  });

  it("falls through a blank runtime setting to env", () => {
    const runtime = runtimeWith({ ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "  " });
    expect(
      lifeOpsPassiveConnectorsSetting(runtime, {
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "off",
      }),
    ).toBe(false);
  });

  it("prefers a non-blank runtime setting over env", () => {
    const runtime = runtimeWith({ ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "true" });
    expect(
      lifeOpsPassiveConnectorsSetting(runtime, {
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
      }),
    ).toBe(true);
  });
});

describe("lifeOpsPassiveConnectorsEnabled", () => {
  it("is not passive with a blank env and no passive plugin", () => {
    expect(
      lifeOpsPassiveConnectorsEnabled(runtimeWith({}), {
        LIFEOPS_PASSIVE_CONNECTORS: "",
      }),
    ).toBe(false);
  });

  it("uses the plugin capability when the env value is blank", () => {
    const runtime = runtimeWith({}, [
      { name: "lifeops", passiveConnectorsByDefault: true },
    ]);
    expect(
      lifeOpsPassiveConnectorsEnabled(runtime, {
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "  ",
      }),
    ).toBe(true);
  });

  it("lets an explicit false override the plugin capability", () => {
    const runtime = runtimeWith({}, [
      { name: "lifeops", passiveConnectorsByDefault: true },
    ]);
    expect(
      lifeOpsPassiveConnectorsEnabled(runtime, {
        LIFEOPS_PASSIVE_CONNECTORS: "false",
      }),
    ).toBe(false);
  });
});
