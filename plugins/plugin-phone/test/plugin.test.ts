import { describe, expect, it } from "vitest";

import { appPhonePlugin } from "../src/plugin.ts";
import * as phoneExports from "../src/index.ts";

describe("appPhonePlugin manifest", () => {
  it("keeps VOICE_CALL host-adapted by personal-assistant", () => {
    expect(appPhonePlugin.actions ?? []).toEqual([]);
    expect("voiceCallAction" in phoneExports).toBe(false);
  });

  it("registers phone views and the read-only call-log provider", () => {
    expect(appPhonePlugin.providers?.map((provider) => provider.name)).toEqual([
      "phoneCallLog",
    ]);
    expect(appPhonePlugin.views?.map((view) => view.viewType ?? "gui")).toEqual([
      "gui",
      "xr",
      "tui",
    ]);
  });
});
