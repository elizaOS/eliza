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
      .forEach((node) => {
        node.remove();
      });
    delete (window as unknown as { __elizaTabKit?: unknown }).__elizaTabKit;
    delete (window as unknown as { __elizaTabExec?: unknown }).__elizaTabExec;
    globalThis.__electrobunSendToHost = undefined;
  });

  afterEach(() => {
    document.documentElement
      .querySelectorAll("[data-eliza-cursor]")
      .forEach((node) => {
        node.remove();
      });
  });

  function installPreload(): void {
    // biome-ignore lint/security/noGlobalEval: test intentionally executes the generated preload script in the jsdom global realm.
    globalThis.eval(BROWSER_TAB_PRELOAD_SCRIPT);
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
      .forEach((node) => {
        node.remove();
      });
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
    // biome-ignore lint/security/noGlobalEval: test intentionally executes the generated preload script in the jsdom global realm.
    globalThis.eval(BROWSER_TAB_PRELOAD_SCRIPT);
  }

  it("installs window.ethereum (EIP-1193) and routes request() through the host bridge", async () => {
    let captured: Record<string, unknown> | null = null;
    (
      window as unknown as { __electrobunSendToHost: (p: unknown) => void }
    ).__electrobunSendToHost = (payload) => {
      captured = payload as Record<string, unknown>;
    };
    installPreload();

    const eth = (
      window as unknown as {
        ethereum?: {
          request: (a: unknown) => Promise<unknown>;
          isEliza: boolean;
        };
      }
    ).ethereum;
    expect(eth).toBeTruthy();
    expect(eth?.isEliza).toBe(true);
    if (!eth) throw new Error("Eliza Ethereum provider was not installed.");

    const promise = eth.request({
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
          isEliza: boolean;
          connect: () => Promise<unknown>;
        };
      }
    ).solana;
    expect(sol).toBeTruthy();
    expect(sol?.isPhantom).toBe(true);
    expect(sol?.isEliza).toBe(true);
    if (!sol) throw new Error("Eliza Solana provider was not installed.");

    const promise = sol.connect();
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

describe("BROWSER_TAB_PRELOAD_SCRIPT — vault autofill shim", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement
      .querySelectorAll("[data-eliza-cursor]")
      .forEach((node) => {
        node.remove();
      });
    delete (window as unknown as { __elizaTabKit?: unknown }).__elizaTabKit;
    delete (window as unknown as { __elizaWalletInstalled?: boolean })
      .__elizaWalletInstalled;
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    delete (window as unknown as { solana?: unknown }).solana;
    delete (window as unknown as { phantom?: unknown }).phantom;
    delete (window as unknown as { __elizaVaultInstalled?: boolean })
      .__elizaVaultInstalled;
    delete (
      window as unknown as { __electrobunSendToHost?: (p: unknown) => void }
    ).__electrobunSendToHost;
  });

  function installPreload(): void {
    // biome-ignore lint/security/noGlobalEval: test executes the generated preload script in the jsdom global realm.
    globalThis.eval(BROWSER_TAB_PRELOAD_SCRIPT);
  }

  function flushTasks(): Promise<void> {
    // The preload schedules a 250ms scan. JSDOM has fake/no-fake-timers
    // disabled here, so we yield + wait for real time to elapse.
    return new Promise((resolve) => setTimeout(resolve, 300));
  }

  it("emits __elizaVaultAutofillRequest when a login form is detected", async () => {
    const captured: Record<string, unknown>[] = [];
    (
      window as unknown as { __electrobunSendToHost: (p: unknown) => void }
    ).__electrobunSendToHost = (payload) => {
      captured.push(payload as Record<string, unknown>);
    };

    // Build a login form before installing the preload — the preload's
    // scan runs on install so the form must be in the DOM first.
    const form = document.createElement("form");
    const userInput = document.createElement("input");
    userInput.type = "email";
    userInput.id = "username";
    userInput.name = "user";
    const pwInput = document.createElement("input");
    pwInput.type = "password";
    pwInput.id = "password";
    form.appendChild(userInput);
    form.appendChild(pwInput);
    document.body.appendChild(form);

    installPreload();
    await flushTasks();

    const vaultRequests = captured.filter(
      (p) => p.type === "__elizaVaultAutofillRequest",
    );
    expect(vaultRequests.length).toBeGreaterThanOrEqual(1);
    const req = vaultRequests[0] as {
      requestId: number;
      domain: string;
      url: string;
      fieldHints: Array<{ kind: string; selector: string }>;
    };
    expect(typeof req.requestId).toBe("number");
    expect(typeof req.domain).toBe("string");
    expect(req.fieldHints.length).toBe(2);
    const kinds = req.fieldHints.map((h) => h.kind).sort();
    expect(kinds).toEqual(["password", "username"]);
    // Selectors must resolve back to the original inputs.
    for (const hint of req.fieldHints) {
      const el = document.querySelector(hint.selector);
      expect(el).toBeTruthy();
    }
  });

  it("fills inputs with native setter + dispatches input/change on host reply", async () => {
    const captured: Record<string, unknown>[] = [];
    (
      window as unknown as { __electrobunSendToHost: (p: unknown) => void }
    ).__electrobunSendToHost = (payload) => {
      captured.push(payload as Record<string, unknown>);
    };

    const form = document.createElement("form");
    const userInput = document.createElement("input");
    userInput.type = "email";
    userInput.id = "user-eml";
    userInput.name = "email";
    const pwInput = document.createElement("input");
    pwInput.type = "password";
    pwInput.id = "user-pw";
    form.appendChild(userInput);
    form.appendChild(pwInput);
    document.body.appendChild(form);

    const inputEvents: string[] = [];
    const changeEvents: string[] = [];
    userInput.addEventListener("input", () => inputEvents.push("user"));
    userInput.addEventListener("change", () => changeEvents.push("user"));
    pwInput.addEventListener("input", () => inputEvents.push("pw"));
    pwInput.addEventListener("change", () => changeEvents.push("pw"));

    installPreload();
    await flushTasks();

    const req = captured.find(
      (p) => p.type === "__elizaVaultAutofillRequest",
    ) as {
      requestId: number;
      fieldHints: Array<{ kind: string; selector: string }>;
    };
    expect(req).toBeTruthy();

    const userSel =
      req.fieldHints.find((h) => h.kind === "username")?.selector ?? "";
    const pwSel =
      req.fieldHints.find((h) => h.kind === "password")?.selector ?? "";
    expect(userSel).toBeTruthy();
    expect(pwSel).toBeTruthy();
    // Selectors must locate the original elements.
    expect(document.querySelector(userSel)).toBe(userInput);
    expect(document.querySelector(pwSel)).toBe(pwInput);

    (
      window as unknown as {
        __elizaVaultReply: (id: number, p: unknown) => void;
      }
    ).__elizaVaultReply(req.requestId, {
      fields: {
        [userSel]: "alice@example.com",
        [pwSel]: "hunter2",
      },
    });
    // Reply schedules a microtask before fillFields runs (Promise then),
    // so wait once for it to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(userInput.value).toBe("alice@example.com");
    expect(pwInput.value).toBe("hunter2");
    expect(inputEvents).toContain("user");
    expect(inputEvents).toContain("pw");
    expect(changeEvents).toContain("user");
    expect(changeEvents).toContain("pw");
  });

  it("does nothing when the host replies with an empty fields map", async () => {
    const captured: Record<string, unknown>[] = [];
    (
      window as unknown as { __electrobunSendToHost: (p: unknown) => void }
    ).__electrobunSendToHost = (payload) => {
      captured.push(payload as Record<string, unknown>);
    };

    const pwInput = document.createElement("input");
    pwInput.type = "password";
    pwInput.id = "lonely-pw";
    document.body.appendChild(pwInput);

    installPreload();
    await flushTasks();

    const req = captured.find(
      (p) => p.type === "__elizaVaultAutofillRequest",
    ) as { requestId: number };
    expect(req).toBeTruthy();

    (
      window as unknown as {
        __elizaVaultReply: (id: number, p: unknown) => void;
      }
    ).__elizaVaultReply(req.requestId, { fields: {} });

    expect(pwInput.value).toBe("");
  });
});
