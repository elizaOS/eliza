// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairingPayload } from "../services";

// Controllable fake SessionClient so we can drive connState transitions and
// assert connect()/close() lifecycle without a real WebSocket.
type StateListener = (state: string) => void;
const fakeClients = vi.hoisted(
  () =>
    [] as Array<{
      stateListeners: Set<StateListener>;
      connect: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      sendInput: ReturnType<typeof vi.fn>;
      emitState: (s: string) => void;
    }>,
);

vi.mock("../services", async () => {
  const actual =
    await vi.importActual<typeof import("../services")>("../services");
  class FakeSessionClient {
    stateListeners = new Set<StateListener>();
    errorListeners = new Set<(e: Error) => void>();
    connect = vi.fn();
    close = vi.fn();
    sendInput = vi.fn();
    on(event: string, handler: (value: unknown) => void): () => void {
      if (event === "state") {
        this.stateListeners.add(handler as StateListener);
        return () => this.stateListeners.delete(handler as StateListener);
      }
      this.errorListeners.add(handler as (e: Error) => void);
      return () => this.errorListeners.delete(handler as (e: Error) => void);
    }
    emitState(s: string) {
      for (const l of this.stateListeners) l(s);
    }
    constructor() {
      fakeClients.push(this as never);
    }
  }
  return {
    ...actual,
    SessionClient: FakeSessionClient,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { RemoteSession } from "./RemoteSession";

const validPayload: PairingPayload = {
  agentId: "agent-42",
  pairingCode: "code-42",
  ingressUrl: "wss://relay.example/input",
  sessionToken: "tok-42",
};

beforeEach(() => {
  fakeClients.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function lastClient() {
  return fakeClients[fakeClients.length - 1];
}

describe("RemoteSession — valid wss ingress", () => {
  it("builds the viewer iframe URL with token + agent and connects to /input", () => {
    render(<RemoteSession payload={validPayload} onExit={vi.fn()} />);

    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    const src = new URL(iframe.src);
    expect(src.protocol).toBe("https:");
    expect(src.host).toBe("relay.example");
    expect(src.pathname).toBe("/vnc");
    expect(src.searchParams.get("token")).toBe("tok-42");
    expect(src.searchParams.get("agent")).toBe("agent-42");

    // connect() was called against the /input WS endpoint with the token.
    const client = lastClient();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledWith(
      "wss://relay.example/input",
      "tok-42",
    );
  });

  it("maps connState 'open' to the Connected status label", async () => {
    render(<RemoteSession payload={validPayload} onExit={vi.fn()} />);
    expect(screen.getByText("Connecting...")).toBeTruthy();

    act(() => {
      lastClient().emitState("open");
    });
    await screen.findByText("Connected");
  });

  it("Reconnect is enabled and re-invokes connect on a fresh client", async () => {
    render(<RemoteSession payload={validPayload} onExit={vi.fn()} />);
    const reconnect = screen.getByRole("button", {
      name: "Reconnect",
    }) as HTMLButtonElement;
    expect(reconnect.disabled).toBe(false);
    const firstClient = lastClient();

    fireEvent.click(reconnect);
    await waitFor(() => expect(fakeClients.length).toBe(2));
    expect(firstClient.close).toHaveBeenCalled();
    expect(lastClient().connect).toHaveBeenCalledWith(
      "wss://relay.example/input",
      "tok-42",
    );
  });

  it("Exit button invokes onExit", () => {
    const onExit = vi.fn();
    render(<RemoteSession payload={validPayload} onExit={onExit} />);
    fireEvent.click(screen.getByRole("button", { name: "Exit" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe("RemoteSession — unsafe ingress", () => {
  it("blocks a plaintext ws:// on a public host: about:blank + error + no connect", () => {
    render(
      <RemoteSession
        payload={{ ...validPayload, ingressUrl: "ws://public.example/input" }}
        onExit={vi.fn()}
      />,
    );

    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe("about:blank");

    // Error message rendered in the status slot; Reconnect disabled.
    const reconnect = screen.getByRole("button", {
      name: "Reconnect",
    }) as HTMLButtonElement;
    expect(reconnect.disabled).toBe(true);
    expect(
      screen.getByText(/ws:\/\/ is only allowed on localhost/),
    ).toBeTruthy();

    // No SessionClient was constructed for an unsafe URL.
    expect(fakeClients.length).toBe(0);

    // Input surface is non-interactive.
    const surface = iframe.parentElement?.querySelector(
      "div[style]",
    ) as HTMLElement;
    expect(surface.style.pointerEvents).toBe("none");
  });

  it("rejects an ingress that embeds credentials", () => {
    render(
      <RemoteSession
        payload={{
          ...validPayload,
          ingressUrl: "wss://user:pass@relay.example/input",
        }}
        onExit={vi.fn()}
      />,
    );
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe("about:blank");
    expect(
      screen.getByText("Companion ingress URL must not embed credentials"),
    ).toBeTruthy();
    expect(fakeClients.length).toBe(0);
  });

  it("rejects the cloud metadata host", () => {
    render(
      <RemoteSession
        payload={{
          ...validPayload,
          ingressUrl: "wss://169.254.169.254/input",
        }}
        onExit={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Companion ingress host is not allowed"),
    ).toBeTruthy();
    expect(fakeClients.length).toBe(0);
  });

  it("rejects a non-websocket scheme", () => {
    render(
      <RemoteSession
        payload={{ ...validPayload, ingressUrl: "http://relay.example/input" }}
        onExit={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Companion ingress must use wss: or ws: (WebSocket) URL",
      ),
    ).toBeTruthy();
    expect(fakeClients.length).toBe(0);
  });
});
