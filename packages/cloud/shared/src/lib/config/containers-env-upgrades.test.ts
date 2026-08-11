import { afterEach, describe, expect, test } from "bun:test";
import { containersEnv } from "./containers-env";

const KEYS = ["MAX_INFLIGHT_UPGRADES", "CONTAINERS_MAX_INFLIGHT_UPGRADES"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("maxInflightUpgrades", () => {
  test("defaults to three and accepts zero as an operational pause", () => {
    setEnv({});
    expect(containersEnv.maxInflightUpgrades()).toBe(3);

    setEnv({ MAX_INFLIGHT_UPGRADES: "0" });
    expect(containersEnv.maxInflightUpgrades()).toBe(0);
  });

  test("prefers the established name and supports the CONTAINERS alias", () => {
    setEnv({ CONTAINERS_MAX_INFLIGHT_UPGRADES: "7" });
    expect(containersEnv.maxInflightUpgrades()).toBe(7);

    setEnv({
      MAX_INFLIGHT_UPGRADES: "2",
      CONTAINERS_MAX_INFLIGHT_UPGRADES: "7",
    });
    expect(containersEnv.maxInflightUpgrades()).toBe(2);
  });

  test("clamps finite integers to the safe range and rejects invalid values", () => {
    setEnv({ MAX_INFLIGHT_UPGRADES: "-4" });
    expect(containersEnv.maxInflightUpgrades()).toBe(0);

    setEnv({ MAX_INFLIGHT_UPGRADES: "99" });
    expect(containersEnv.maxInflightUpgrades()).toBe(64);

    setEnv({ MAX_INFLIGHT_UPGRADES: "2.9" });
    expect(containersEnv.maxInflightUpgrades()).toBe(2);

    setEnv({ MAX_INFLIGHT_UPGRADES: "not-a-number" });
    expect(containersEnv.maxInflightUpgrades()).toBe(3);
  });
});
