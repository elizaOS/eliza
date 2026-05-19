import { beforeEach, describe, expect, it, vi } from "vitest";

const sendWsMessage = vi.fn();

vi.mock("../../api", () => ({
  client: { sendWsMessage },
}));

describe("view-interact-registry", () => {
  beforeEach(() => {
    sendWsMessage.mockClear();
    vi.resetModules();
  });

  it("dispatches to handlers by view type and logical view id", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );

    registerViewInteractHandler("views-manager", "gui", async () => ({
      surface: "gui",
    }));
    registerViewInteractHandler("views-manager", "tui", async () => ({
      surface: "tui",
    }));

    await dispatchViewInteract(
      "views-manager",
      "tui",
      "get-state",
      undefined,
      "req-1",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-1",
      success: true,
      result: { surface: "tui" },
    });
  });

  it("defaults missing view type to gui", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );

    registerViewInteractHandler("wallet", "gui", async () => ({
      surface: "gui",
    }));

    await dispatchViewInteract(
      "wallet",
      undefined,
      "get-state",
      undefined,
      "req-2",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-2",
      success: true,
      result: { surface: "gui" },
    });
  });
});
