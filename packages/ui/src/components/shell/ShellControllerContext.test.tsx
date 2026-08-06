// @vitest-environment jsdom
/**
 * Owner + follower provider wiring. The owner path is rendered with a stubbed
 * `useShellController` (the engine itself is tested elsewhere; here we prove the
 * OWNER publishes + routes commands to it). The follower path is rendered with a
 * plain sync DTO and proves it renders the snapshot and forwards commands
 * without ever mounting the engine.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FollowerShellControllerProvider,
  OwnerShellControllerProvider,
} from "./ShellControllerContext";
import { useShellControllerContext } from "./ShellControllerContext.hooks";
import {
  baseSnapshot,
  makeFakeShellController,
} from "./shell-controller-sync/__tests__/fixtures";
import type { ShellControllerSync } from "./shell-controller-sync/useShellControllerSync";
import { useShellController } from "./useShellController";

vi.mock("./useShellController", () => ({ useShellController: vi.fn() }));

let fakeController = makeFakeShellController();
beforeEach(() => {
  fakeController = makeFakeShellController();
  vi.mocked(useShellController).mockReturnValue(fakeController);
});

function Consumer(): React.JSX.Element {
  const controller = useShellControllerContext();
  if (!controller) return <div data-testid="state">no-controller</div>;
  return (
    <div>
      <span data-testid="transcript">{controller.transcript}</span>
      <button type="button" onClick={() => controller.send("hi from follower")}>
        send
      </button>
    </div>
  );
}

function DictationConsumer({
  onText,
}: {
  onText: (text: string) => void;
}): React.JSX.Element {
  const controller = useShellControllerContext();
  React.useEffect(() => {
    controller?.setDictationSink(onText);
    return () => controller?.setDictationSink(null);
  }, [controller, onText]);
  return <div>dictation-consumer</div>;
}

function makeSync(over: Partial<ShellControllerSync>): ShellControllerSync {
  return {
    role: "follower",
    status: "connected",
    snapshot: null,
    endpointId: null,
    generation: 0,
    dispatch: vi.fn(async () => {}),
    publishSnapshot: vi.fn(),
    deliver: vi.fn(async () => {}),
    setCommandHandler: vi.fn(),
    setDeliveryHandler: vi.fn(),
    reportError: vi.fn(),
    ...over,
  };
}

describe("FollowerShellControllerProvider", () => {
  it("renders the owner's snapshot and forwards a send command", async () => {
    const dispatch = vi.fn(async () => {});
    const sync = makeSync({
      snapshot: baseSnapshot({ transcript: "from-owner" }),
      dispatch,
    });
    render(
      <FollowerShellControllerProvider sync={sync} onCommandError={() => {}}>
        <Consumer />
      </FollowerShellControllerProvider>,
    );
    expect(screen.getByTestId("transcript").textContent).toBe("from-owner");

    await userEvent.click(screen.getByRole("button", { name: "send" }));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "send",
      text: "hi from follower",
    });
  });

  it("provides no controller (overlay hidden) with no snapshot yet", () => {
    render(
      <FollowerShellControllerProvider
        sync={makeSync({ snapshot: null })}
        onCommandError={() => {}}
      >
        <Consumer />
      </FollowerShellControllerProvider>,
    );
    expect(screen.getByTestId("state").textContent).toBe("no-controller");
  });

  it("delivers dictation into the initiating follower's local sink", () => {
    const setDeliveryHandler = vi.fn();
    const onText = vi.fn();
    const sync = makeSync({
      snapshot: baseSnapshot(),
      setDeliveryHandler,
    });
    render(
      <FollowerShellControllerProvider sync={sync} onCommandError={() => {}}>
        <DictationConsumer onText={onText} />
      </FollowerShellControllerProvider>,
    );
    const deliver = setDeliveryHandler.mock.calls[0]?.[0] as (delivery: {
      kind: "dictation";
      text: string;
    }) => void;
    deliver({ kind: "dictation", text: "private draft" });
    expect(onText).toHaveBeenCalledWith("private draft");
  });
});

describe("OwnerShellControllerProvider", () => {
  it("publishes the engine snapshot and routes commands to the real controller", () => {
    const setCommandHandler = vi.fn();
    const publishSnapshot = vi.fn();
    const sync = makeSync({
      role: "owner",
      setCommandHandler,
      publishSnapshot,
    });
    render(
      <OwnerShellControllerProvider sync={sync}>
        <div>owner-child</div>
      </OwnerShellControllerProvider>,
    );

    // The owner published its state to followers.
    expect(publishSnapshot).toHaveBeenCalled();

    // The registered command handler applies commands to the live engine.
    expect(setCommandHandler).toHaveBeenCalledWith(expect.any(Function));
    const handler = setCommandHandler.mock.calls[0]?.[0] as (
      c: { kind: "stop" },
      fromEndpointId: string,
    ) => Promise<void>;
    void handler({ kind: "stop" }, "follower-1");
    expect(fakeController.stop).toHaveBeenCalledTimes(1);
  });

  it("routes completed dictation only to the follower that started it", async () => {
    const setCommandHandler = vi.fn();
    const deliver = vi.fn(async () => {});
    const sync = makeSync({ role: "owner", setCommandHandler, deliver });
    render(
      <OwnerShellControllerProvider sync={sync}>
        <div>owner-child</div>
      </OwnerShellControllerProvider>,
    );
    const commandHandler = setCommandHandler.mock.calls[0]?.[0] as (
      command: { kind: "startRecording"; intent: "dictate" },
      fromEndpointId: string,
    ) => Promise<void>;
    await commandHandler(
      { kind: "startRecording", intent: "dictate" },
      "follower-7",
    );
    const nativeSink = vi.mocked(fakeController.setDictationSink).mock
      .calls[0]?.[0];
    nativeSink?.("captured words");
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledWith("follower-7", {
        kind: "dictation",
        text: "captured words",
      }),
    );
  });
});
