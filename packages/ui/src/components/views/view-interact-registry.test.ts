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

  it("ignores requests for unmounted views", async () => {
    const { dispatchViewInteract } = await import("./view-interact-registry");

    await dispatchViewInteract(
      "missing-view",
      "gui",
      "get-state",
      undefined,
      "req-missing",
    );

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it("returns a failure result when a handler throws", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );

    registerViewInteractHandler("broken-view", "gui", async () => {
      throw new Error("interact failed");
    });

    await dispatchViewInteract(
      "broken-view",
      "gui",
      "refresh",
      undefined,
      "req-error",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-error",
      success: false,
      error: "interact failed",
    });
  });

  it("executes each request id at most once", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );
    const handler = vi.fn(async () => ({ ok: true }));
    registerViewInteractHandler("notes", "gui", handler);

    await dispatchViewInteract(
      "notes",
      "gui",
      "create-note",
      undefined,
      "req-dupe",
    );
    await dispatchViewInteract(
      "notes",
      "gui",
      "create-note",
      undefined,
      "req-dupe",
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
  });

  it("stringifies non-Error handler failures", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );

    registerViewInteractHandler("string-failure", "gui", async () => {
      throw "plain failure";
    });

    await dispatchViewInteract(
      "string-failure",
      "gui",
      "refresh",
      undefined,
      "req-string-error",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-string-error",
      success: false,
      error: "plain failure",
    });
  });

  it("unregisters handlers and does not remove a newer replacement handler", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );
    const firstUnregister = registerViewInteractHandler(
      "replaceable",
      "gui",
      async () => ({ version: 1 }),
    );
    const secondUnregister = registerViewInteractHandler(
      "replaceable",
      "gui",
      async () => ({ version: 2 }),
    );

    firstUnregister();
    await dispatchViewInteract(
      "replaceable",
      "gui",
      "get-state",
      undefined,
      "req-replaced",
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-replaced",
      success: true,
      result: { version: 2 },
    });

    sendWsMessage.mockClear();
    secondUnregister();
    await dispatchViewInteract(
      "replaceable",
      "gui",
      "get-state",
      undefined,
      "req-unregistered",
    );
    expect(sendWsMessage).not.toHaveBeenCalled();
  });
});
