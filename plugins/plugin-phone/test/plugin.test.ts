/**
 * Guards the appPhonePlugin manifest shape: no actions (VOICE_CALL stays
 * host-adapted by personal-assistant), exactly the phoneCallLog provider, and
 * one shipped phone GUI view.
 */

import { describe, expect, it } from "vitest";
import * as phoneExports from "../src/index.ts";
import { appPhonePlugin } from "../src/plugin.ts";

describe("appPhonePlugin manifest", () => {
  it("keeps VOICE_CALL host-adapted by personal-assistant", () => {
    expect(appPhonePlugin.actions ?? []).toEqual([]);
    expect("voiceCallAction" in phoneExports).toBe(false);
  });

  it("registers one phone GUI view and the read-only call-log provider", () => {
    expect(appPhonePlugin.providers?.map((provider) => provider.name)).toEqual([
      "phoneCallLog",
    ]);

    // Single source of truth: one GUI declaration drawn from PhoneView. The
    // modality enum remains available for future alternate view entries.
    const views = appPhonePlugin.views ?? [];
    expect(views).toHaveLength(1);
    const [view] = views;
    expect(view.id).toBe("phone");
    expect(view.componentExport).toBe("PhoneView");
    expect(view.modalities).toEqual(["gui"]);
    // No per-viewType duplicate declarations remain.
    expect(view.viewType).toBeUndefined();
  });
});
