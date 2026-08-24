import { describe, expect, it } from "vitest";
import {
  CONFIG_SELECT_FLOATING_LAYER_NAME,
  CONFIG_SELECT_FLOATING_LAYER_Z_INDEX,
  Z_BASE,
  Z_BUILD_BADGE,
  Z_DIALOG,
  Z_DIALOG_OVERLAY,
  Z_DROPDOWN,
  Z_GLOBAL_EMOTE,
  Z_MODAL,
  Z_MODAL_BACKDROP,
  Z_OVERLAY,
  Z_SHELL_OVERLAY,
  Z_STICKY,
  Z_SYSTEM_BANNER,
  Z_SYSTEM_CRITICAL,
  Z_TOOLTIP,
  Z_VIEW_MODAL,
  Z_VIEW_MODAL_BACKDROP,
} from "./floating-layers.js";

describe("floating-layers", () => {
  it("z-index values are sparse and ordered", () => {
    expect(Z_BASE).toBe(0);
    expect(Z_DROPDOWN).toBeLessThan(Z_STICKY);
    expect(Z_STICKY).toBeLessThan(Z_MODAL_BACKDROP);
    expect(Z_MODAL_BACKDROP).toBeLessThan(Z_MODAL);
    expect(Z_MODAL).toBeLessThan(Z_DIALOG_OVERLAY);
    expect(Z_DIALOG_OVERLAY).toBeLessThan(Z_DIALOG);
    expect(Z_DIALOG).toBeLessThan(Z_OVERLAY);
    expect(Z_OVERLAY).toBeLessThan(Z_TOOLTIP);
    expect(Z_TOOLTIP).toBeLessThan(Z_VIEW_MODAL_BACKDROP);
  });

  it("shell and system layers are highest in app chrome", () => {
    expect(Z_VIEW_MODAL_BACKDROP).toBeLessThan(Z_VIEW_MODAL);
    expect(Z_VIEW_MODAL).toBeLessThan(Z_SHELL_OVERLAY);
    expect(Z_SHELL_OVERLAY).toBeLessThan(Z_SYSTEM_BANNER);
    expect(Z_SYSTEM_BANNER).toBeLessThan(Z_SYSTEM_CRITICAL);
    expect(Z_SYSTEM_CRITICAL).toBeLessThan(Z_GLOBAL_EMOTE);
    expect(Z_GLOBAL_EMOTE).toBeLessThan(Z_BUILD_BADGE);
  });

  it("config select is above app chrome but below badge", () => {
    expect(CONFIG_SELECT_FLOATING_LAYER_NAME).toBe("config-select");
    expect(CONFIG_SELECT_FLOATING_LAYER_Z_INDEX).toBeGreaterThan(
      Z_GLOBAL_EMOTE,
    );
    expect(CONFIG_SELECT_FLOATING_LAYER_Z_INDEX).toBeLessThan(Z_BUILD_BADGE);
  });
});
