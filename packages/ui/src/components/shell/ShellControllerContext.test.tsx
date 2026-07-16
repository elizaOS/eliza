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
import type * as React from "react";
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

function makeSync(over: Partial<ShellControllerSync>): ShellControllerSync {
  return {
    role: "follower",
    status: "connected",
    snapshot: null,
    dispatch: vi.fn(async () => {}),
    publishSnapshot: vi.fn(),
    setCommandHandler: vi.fn(),
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
});

describe("OwnerShellControllerProvider", () => {
  it("publishes the engine snapshot and routes commands to the real controller", () => {
    const setCommandHandler = vi.fn();
    const publishSnapshot = vi.fn();
    const sync = makeSync({ role: "owner", setCommandHandler, publishSnapshot });
    render(
      <OwnerShellControllerProvider sync={sync}>
        <div>owner-child</div>
      </OwnerShellControllerProvider>,
    );

    // The owner published its state to followers.
    expect(publishSnapshot).toHaveBeenCalled();

    // The registered command handler applies commands to the live engine.
    expect(setCommandHandler).toHaveBeenCalledWith(expect.any(Function));
    const handler = setCommandHandler.mock.calls[0]?.[0] as (c: {
      kind: string;
    }) => void;
    handler({ kind: "stop" });
    expect(fakeController.stop).toHaveBeenCalledTimes(1);
  });
});
