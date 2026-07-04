/**
 * Guards the appPhonePlugin manifest shape: no actions (VOICE_CALL stays
 * host-adapted by personal-assistant), exactly the phoneCallLog provider, and
 * one phone view spanning all three modalities.
 */

import { describe, expect, it } from "vitest";
import * as phoneExports from "../src/index.ts";
import { appPhonePlugin } from "../src/plugin.ts";

describe("appPhonePlugin manifest", () => {
  it("keeps VOICE_CALL host-adapted by personal-assistant", () => {
    expect(appPhonePlugin.actions ?? []).toEqual([]);
    expect("voiceCallAction" in phoneExports).toBe(false);
  });

  it("registers ONE phone view drawing all three modalities + the read-only call-log provider", () => {
    expect(appPhonePlugin.providers?.map((provider) => provider.name)).toEqual([
      "phoneCallLog",
    ]);

    // Single source of truth: one declaration, modalities ["gui","xr","tui"],
    // the unified PhoneView spatial component.
    const views = appPhonePlugin.views ?? [];
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view.id).toBe("phone");
    expect(view.componentExport).toBe("PhoneView");
    expect(view.modalities).toEqual(["gui", "xr", "tui"]);
    // No per-viewType duplicate declarations remain.
    expect(view.viewType).toBeUndefined();
  });
});
