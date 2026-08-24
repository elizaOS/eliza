/**
 * Behavioural coverage for the scaffolded min-plugin info provider: identity
 * metadata and the static provider result returned across repeated
 * resolutions without depending on runtime arguments.
 */

import { describe, expect, it } from "vitest";
import { infoProvider } from "../src/providers/info.js";

type ProviderGetArgs = Parameters<typeof infoProvider.get>;

describe("infoProvider", () => {
  it("exposes the templated plugin identity metadata", () => {
    expect(infoProvider.name).toBe("__PLUGIN_NAME___INFO");
    expect(infoProvider.description).toBe(
      "Static info provider for the __PLUGIN_NAME__ plugin.",
    );
  });

  it("resolves the complete active payload without touching runtime arguments", async () => {
    const result = await infoProvider.get(
      undefined as unknown as ProviderGetArgs[0],
      undefined as unknown as ProviderGetArgs[1],
      undefined as unknown as ProviderGetArgs[2],
    );

    expect(result).toEqual({
      text: "[__PLUGIN_NAME__] active",
      values: { pluginName: "__PLUGIN_NAME__" },
      data: {},
    });
  });

  it("returns a fresh result object on every resolution", async () => {
    const resolve = () =>
      infoProvider.get(
        undefined as unknown as ProviderGetArgs[0],
        undefined as unknown as ProviderGetArgs[1],
        undefined as unknown as ProviderGetArgs[2],
      );

    const first = await resolve();
    const second = await resolve();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.is(first.values, second.values)).toBe(false);
  });
});
