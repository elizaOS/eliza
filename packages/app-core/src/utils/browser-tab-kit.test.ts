// @vitest-environment jsdom
/**
 * Smoke checks for the in-tab kit installed by BROWSER_TAB_PRELOAD_SCRIPT.
 *
 * The preload runs inside an OOPIF in production. We exercise it in
 * happy-dom via vitest by `eval`ing the script string in the test
 * environment, then asserting the cursor element + dispatchPointerSequence
 * fire the right DOM events in the right order.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_TAB_PRELOAD_SCRIPT } from "./browser-tabs-renderer-registry";

declare global {
  // eslint-disable-next-line no-var
  var __electrobunSendToHost: ((payload: unknown) => void) | undefined;
}

describe("BROWSER_TAB_PRELOAD_SCRIPT", () => {
  beforeEach(() => {
    // Reset DOM + window globals between tests so each one installs a
    // fresh kit.
    document.body.innerHTML = "";
    document.documentElement
      .querySelectorAll("[data-eliza-cursor]")
      .forEach((node) => node.remove());
    delete (window as unknown as { __elizaTabKit?: unknown }).__elizaTabKit;
    delete (window as unknown as { __elizaTabExec?: unknown }).__elizaTabExec;
    globalThis.__electrobunSendToHost = undefined;
  });

  afterEach(() => {
    document.documentElement
      .querySelectorAll("[data-eliza-cursor]")
      .forEach((node) => node.remove());
  });

  function installPreload(): void {
    // Indirect eval to run in the global scope of the test realm.
    (0, eval)(BROWSER_TAB_PRELOAD_SCRIPT);
  }

  it("installs __elizaTabKit and lazily mounts the cursor overlay on first show", () => {
    installPreload();
    const kit = (
      window as unknown as {
        __elizaTabKit?: { cursor: { show: () => void } };
      }
    ).__elizaTabKit;
    expect(kit).toBeTruthy();
    // Cursor is lazy — installed but not yet rendered until first show().
    expect(
      document.documentElement.querySelector("[data-eliza-cursor]"),
    ).toBeNull();
    kit?.cursor.show();
    expect(
      document.documentElement.querySelector("[data-eliza-cursor]"),
    ).toBeTruthy();
  });

  it("dispatches pointer + mouse events in a faithful sequence on click", async () => {
    installPreload();
    const button = document.createElement("button");
    button.textContent = "Click";
    document.body.appendChild(button);

    const captured: string[] = [];
    const types = [
      "pointerover",
      "mouseover",
      "pointermove",
      "mousemove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ];
    for (const type of types) {
      button.addEventListener(type, () => captured.push(type));
    }

    const kit = (
      window as unknown as {
        __elizaTabKit: {
          dispatchPointerSequence: (
            target: Element,
            options?: { x?: number; y?: number },
          ) => Promise<void>;
        };
      }
    ).__elizaTabKit;
    await kit.dispatchPointerSequence(button, { x: 10, y: 10 });

    // Order matters — pointerdown precedes mousedown precedes click etc.
    expect(captured).toEqual(types);
  });

  it("typeRealistic mutates value via the prototype setter so React sees the change", async () => {
    installPreload();
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const inputEvents: string[] = [];
    input.addEventListener("input", (event) =>
      inputEvents.push(String((event as InputEvent).data ?? "")),
    );

    const kit = (
      window as unknown as {
        __elizaTabKit: {
          typeRealistic: (
            target: Element,
            text: string,
            options?: { perCharDelayMs?: number; replace?: boolean },
          ) => Promise<void>;
        };
      }
    ).__elizaTabKit;
    await kit.typeRealistic(input, "abc", { perCharDelayMs: 0, replace: true });

    expect(input.value).toBe("abc");
    // One InputEvent per char + the initial replace clear if any.
    expect(inputEvents.length).toBeGreaterThanOrEqual(3);
  });

  // setFileInput uses the standard DataTransfer-then-assign-to-input.files
  // pattern that real browser engines (WebKit, Blink, Gecko) all accept.
  // JSDOM's stricter IDL checks reject any non-real FileList, so this code
  // path is only meaningfully testable in a real browser. We rely on the
  // engine + wallet-shim tests above for coverage of everything else.
});

describe("BROWSER_TAB_PRELOAD_SCRIPT — wallet shims", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement
      .querySelectorAll("[data-eliza-cursor]")
      .forEach((node) => node.remove());
    delete (window as unknown as { __elizaTabKit?: unknown }).__elizaTabKit;
    delete (window as unknown as { __elizaWalletInstalled?: boolean })
      .__elizaWalletInstalled;
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    delete (window as unknown as { solana?: unknown }).solana;
    delete (window as unknown as { phantom?: unknown }).phantom;
    delete (
      window as unknown as { __electrobunSendToHost?: (p: unknown) => void }
    ).__electrobunSendToHost;
  });

  function installPreload(): void {
    (0, eval)(BROWSER_TAB_PRELOAD_SCRIPT);
  }

  it("installs window.ethereum (EIP-1193) and routes request() through the host bridge", async () => {
    let captured: Record<string, unknown> | null = null;
    (
      window as unknown as { __electrobunSendToHost: (p: unknown) => void }
    ).__electrobunSendToHost = (payload) => {
      captured = payload as Record<string, unknown>;
    };
    installPreload();

    const eth = (window as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown>; isMilady: boolean } }).ethereum;
    expect(eth).toBeTruthy();
    expect(eth?.isMilady).toBe(true);

    const promise = eth!.request({
      method: "eth_requestAccounts",
      params: [],
    });
    expect(captured).toMatchObject({
      type: "__elizaWalletRequest",
      protocol: "evm",
      method: "eth_requestAccounts",
    });

    // Simulate host reply.
    const requestId = (captured as { requestId: number }).requestId;
    (
      window as unknown as {
        __elizaWalletReply: (id: number, p: unknown) => void;
      }
    ).__elizaWalletReply(requestId, { result: ["0xdeadbeef"] });
    await expect(promise).resolves.toEqual(["0xdeadbeef"]);
  });

  it("installs window.solana (Phantom-shaped) and rejects on host error reply", async () => {
    let captured: Record<string, unknown> | null = null;
    (
      window as unknown as { __electrobunSendToHost: (p: unknown) => void }
    ).__electrobunSendToHost = (payload) => {
      captured = payload as Record<string, unknown>;
    };
    installPreload();

    const sol = (
      window as unknown as {
        solana?: {
          isPhantom: boolean;
          isMilady: boolean;
          connect: () => Promise<unknown>;
        };
      }
    ).solana;
    expect(sol).toBeTruthy();
    expect(sol?.isPhantom).toBe(true);
    expect(sol?.isMilady).toBe(true);

    const promise = sol!.connect();
    expect(captured).toMatchObject({
      type: "__elizaWalletRequest",
      protocol: "solana",
      method: "connect",
    });

    const requestId = (captured as { requestId: number }).requestId;
    (
      window as unknown as {
        __elizaWalletReply: (id: number, p: unknown) => void;
      }
    ).__elizaWalletReply(requestId, { error: "user rejected" });
    await expect(promise).rejects.toThrow(/user rejected/);
  });
});
