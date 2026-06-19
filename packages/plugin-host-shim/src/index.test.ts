import { describe, expect, it } from "bun:test";
import {
  getHostShim,
  installHostShim,
  type PluginHostShim,
  resetHostShim,
} from "./index";

const shim: PluginHostShim = {
  on: () => () => {},
  request: async () => null as never,
  resolveViewUrl: (pluginName, relativePath) =>
    new URL(`https://example.test/${pluginName}/${relativePath}`),
};

describe("PluginHostShim singleton", () => {
  it("throws before install, returns the installed shim, and resets", () => {
    resetHostShim();

    expect(() => getHostShim()).toThrow("PluginHostShim not installed");

    installHostShim(shim);
    expect(getHostShim()).toBe(shim);

    resetHostShim();
    expect(() => getHostShim()).toThrow("PluginHostShim not installed");
  });

  it("uses the most recently installed shim", () => {
    resetHostShim();
    const replacement: PluginHostShim = {
      ...shim,
      resolveViewUrl: (pluginName, relativePath) =>
        new URL(`https://replacement.test/${pluginName}/${relativePath}`),
    };

    installHostShim(shim);
    installHostShim(replacement);

    expect(getHostShim()).toBe(replacement);
  });
});
