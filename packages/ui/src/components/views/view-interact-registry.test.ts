/** Verifies view-interact-registry through the package's configured test harness. */
// view-interact-registry: dispatchViewInteract routes to handlers keyed by view
// type + logical view id and returns results over the WS transport. The `client`
// transport is mocked; the registry itself is the real module under test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendWsMessage = vi.fn();
const claim = vi.fn();

vi.mock("../../api", () => ({
  client: { sendWsMessage, fetch: claim, clientId: "test-client" },
}));

describe("view-interact-registry", () => {
  beforeEach(() => {
    sendWsMessage.mockClear();
    claim.mockReset().mockResolvedValue({ claimId: "execution-claim" });
    vi.resetModules();
  });

  it("dispatches to handlers by view type and logical view id", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );

    registerViewInteractHandler(
      "views-manager",
      "gui",
      async () => ({
        surface: "gui",
      }),
      "fixture-installation",
    );
    registerViewInteractHandler(
      "views-manager",
      "tui",
      async () => ({
        surface: "tui",
      }),
      "fixture-installation",
    );

    await dispatchViewInteract(
      "views-manager",
      "tui",
      "get-state",
      undefined,
      "req-1",
      "fixture-installation",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      viewId: "views-manager",
      viewType: "tui",
      installationId: "fixture-installation",
      claimId: "execution-claim",
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

    registerViewInteractHandler(
      "wallet",
      "gui",
      async () => ({
        surface: "gui",
      }),
      "fixture-installation",
    );

    await dispatchViewInteract(
      "wallet",
      undefined,
      "get-state",
      undefined,
      "req-2",
      "fixture-installation",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      viewId: "wallet",
      viewType: "gui",
      installationId: "fixture-installation",
      claimId: "execution-claim",
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
      "fixture-installation",
    );

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it("fails directed native reads immediately when their view is not mounted", async () => {
    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "browser",
      "gui",
      "get-text",
      { nativeOnly: true },
      "native-missing",
      "fixture-installation",
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      viewId: "browser",
      viewType: "gui",
      installationId: "fixture-installation",
      claimId: "execution-claim",
      type: "view:interact:result",
      requestId: "native-missing",
      success: false,
      error: expect.stringContaining(
        "Show that view with VIEWS before reading",
      ),
    });
  });

  it("returns a failure result when a handler throws", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );

    registerViewInteractHandler(
      "broken-view",
      "gui",
      async () => {
        throw new Error("interact failed");
      },
      "fixture-installation",
    );

    await dispatchViewInteract(
      "broken-view",
      "gui",
      "refresh",
      undefined,
      "req-error",
      "fixture-installation",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      viewId: "broken-view",
      viewType: "gui",
      installationId: "fixture-installation",
      claimId: "execution-claim",
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
    registerViewInteractHandler(
      "notes",
      "gui",
      handler,
      "fixture-installation",
    );

    await dispatchViewInteract(
      "notes",
      "gui",
      "create-note",
      undefined,
      "req-dupe",
      "fixture-installation",
    );
    await dispatchViewInteract(
      "notes",
      "gui",
      "create-note",
      undefined,
      "req-dupe",
      "fixture-installation",
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
  });

  it("stringifies non-Error handler failures", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );

    registerViewInteractHandler(
      "string-failure",
      "gui",
      async () => {
        throw "plain failure";
      },
      "fixture-installation",
    );

    await dispatchViewInteract(
      "string-failure",
      "gui",
      "refresh",
      undefined,
      "req-string-error",
      "fixture-installation",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      viewId: "string-failure",
      viewType: "gui",
      installationId: "fixture-installation",
      claimId: "execution-claim",
      type: "view:interact:result",
      requestId: "req-string-error",
      success: false,
      error: "plain failure",
    });
  });

  it("restores a still-mounted handler after an overlapping owner unmounts", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );
    const firstUnregister = registerViewInteractHandler(
      "replaceable",
      "gui",
      async () => ({ version: 1 }),
      "fixture-installation",
    );
    const secondUnregister = registerViewInteractHandler(
      "replaceable",
      "gui",
      async () => ({ version: 2 }),
      "fixture-installation",
    );

    await dispatchViewInteract(
      "replaceable",
      "gui",
      "get-state",
      undefined,
      "req-replaced",
      "fixture-installation",
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      viewId: "replaceable",
      viewType: "gui",
      installationId: "fixture-installation",
      claimId: "execution-claim",
      type: "view:interact:result",
      requestId: "req-replaced",
      success: true,
      result: { version: 2 },
    });

    sendWsMessage.mockClear();
    claim.mockReset().mockResolvedValue({ claimId: "execution-claim" });
    secondUnregister();
    await dispatchViewInteract(
      "replaceable",
      "gui",
      "get-state",
      undefined,
      "req-unregistered",
      "fixture-installation",
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      viewId: "replaceable",
      viewType: "gui",
      installationId: "fixture-installation",
      claimId: "execution-claim",
      type: "view:interact:result",
      requestId: "req-unregistered",
      success: true,
      result: { version: 1 },
    });

    sendWsMessage.mockClear();
    claim.mockReset().mockResolvedValue({ claimId: "execution-claim" });
    firstUnregister();
    await dispatchViewInteract(
      "replaceable",
      "gui",
      "get-state",
      undefined,
      "req-fully-unregistered",
      "fixture-installation",
    );
    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it("keeps the newest owner when an older overlapping owner unmounts first", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );
    const firstUnregister = registerViewInteractHandler(
      "overlap-order",
      "gui",
      async () => ({ version: 1 }),
      "fixture-installation",
    );
    registerViewInteractHandler(
      "overlap-order",
      "gui",
      async () => ({
        version: 2,
      }),
      "fixture-installation",
    );

    firstUnregister();
    await dispatchViewInteract(
      "overlap-order",
      "gui",
      "get-state",
      undefined,
      "req-newest-survives",
      "fixture-installation",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      viewId: "overlap-order",
      viewType: "gui",
      installationId: "fixture-installation",
      claimId: "execution-claim",
      type: "view:interact:result",
      requestId: "req-newest-survives",
      success: true,
      result: { version: 2 },
    });
  });
  it("does not grant a retained handler authority for a replacement installation", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );
    const oldEffect = vi.fn(async () => ({ ok: true }));
    registerViewInteractHandler("notes", "gui", oldEffect, "old-installation");
    await dispatchViewInteract(
      "notes",
      "gui",
      "agent-click",
      { id: "delete" },
      "replacement-request",
      "new-installation",
    );
    expect(oldEffect).not.toHaveBeenCalled();
    expect(sendWsMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
  it("does not execute after its installation is unmounted while claiming", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );
    let finishClaim!: (value: { claimId: string }) => void;
    claim.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishClaim = resolve;
        }),
    );
    const effect = vi.fn(async () => "changed");
    const unmount = registerViewInteractHandler("notes", "gui", effect, "old");
    const pending = dispatchViewInteract(
      "notes",
      "gui",
      "save",
      {},
      "unmount",
      "old",
    );
    unmount();
    registerViewInteractHandler("notes", "gui", effect, "new");
    finishClaim({ claimId: "execution-claim" });
    await pending;
    expect(effect).not.toHaveBeenCalled();
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        installationId: "old",
        claimId: "execution-claim",
      }),
    );
  });

  it("does not execute or retry when the host denies or loses a claim", async () => {
    const { dispatchViewInteract, registerViewInteractHandler } = await import(
      "./view-interact-registry"
    );
    const effect = vi.fn(async () => "changed");
    registerViewInteractHandler("notes", "gui", effect, "current");
    claim.mockRejectedValueOnce(new Error("claim outcome unknown"));
    await dispatchViewInteract("notes", "gui", "save", {}, "lost", "current");
    await dispatchViewInteract("notes", "gui", "save", {}, "lost", "current");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(effect).not.toHaveBeenCalled();
    expect(sendWsMessage).not.toHaveBeenCalled();
  });
});
