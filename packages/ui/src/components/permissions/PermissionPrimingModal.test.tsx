/** Verifies PermissionPrimingModal through the package's configured test harness. */
// @vitest-environment jsdom
//
// PermissionPrimingModal rendering: the active card's concise rationale,
// Continue/Not now actions, non-dismissible shell,
// the recovery callout for a denied card, the loading state, single onComplete
// firing, and explicit Not now. Drives the modal through an injected
// `controllerOverride` stub (the live hook is covered by use-permission-priming.test).
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installJsdomUiPolyfills } from "../../../test/portable-stories";
import { MockAppProvider } from "../../storybook/mock-providers";
import { PermissionPrimingModal } from "./PermissionPrimingModal";
import type {
  PermissionPrimingController,
  PrimingItem,
  PrimingItemStatus,
} from "./use-permission-priming";

beforeAll(() => {
  installJsdomUiPolyfills();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderModal(node: ReactElement) {
  return render(<MockAppProvider>{node}</MockAppProvider>);
}

function item(
  id: PermissionId,
  status: PrimingItemStatus,
  canRequest = false,
): PrimingItem {
  return {
    id,
    status,
    canRequest,
    requesting: false,
    requestError: false,
    recheckError: false,
    resolved: false,
  };
}

function makeController(
  overrides: Partial<PermissionPrimingController> = {},
): PermissionPrimingController {
  return {
    items: [],
    activeIndex: 0,
    active: null,
    currentStep: 1,
    totalSteps: 1,
    ready: true,
    done: false,
    request: vi.fn(async () => {}),
    skip: vi.fn(),
    openSettings: vi.fn(async () => {}),
    recheck: vi.fn(async () => {}),
    skipAll: vi.fn(),
    ...overrides,
  };
}

describe("PermissionPrimingModal", () => {
  it("renders concise copy with Continue and one whole-flow Not now action", () => {
    const controller = makeController({
      items: [item("microphone", "not-determined", true)],
      active: item("microphone", "not-determined", true),
      currentStep: 1,
      totalSteps: 1,
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    expect(screen.getByTestId("priming-card-microphone")).toBeTruthy();
    // MockAppProvider's t returns the defaultValue, so real copy renders.
    expect(screen.getByText("Microphone")).toBeTruthy();
    expect(screen.getByText("Speak to Eliza instead of typing.")).toBeTruthy();
    expect(screen.getByTestId("priming-enable-microphone")).toBeTruthy();
    expect(screen.getByTestId("priming-enable-microphone").textContent).toBe(
      "Continue",
    );
    expect(screen.getByTestId("priming-skip-all").textContent).toBe("Not now");
    expect(screen.queryByTestId("priming-skip-microphone")).toBeNull();
  });

  it("Continue fires the OS request and Not now skips the remaining flow", () => {
    const controller = makeController({
      items: [item("microphone", "not-determined", true)],
      active: item("microphone", "not-determined", true),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    fireEvent.click(screen.getByTestId("priming-enable-microphone"));
    expect(controller.request).toHaveBeenCalledWith("microphone");
    expect(controller.skipAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("priming-skip-all"));
    expect(controller.skipAll).toHaveBeenCalledTimes(1);
  });

  it("stays centered and ignores Escape or backdrop dismissal", () => {
    const controller = makeController({
      items: [item("microphone", "not-determined", true)],
      active: item("microphone", "not-determined", true),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    const modal = screen.getByTestId("permission-priming-modal");
    expect(modal.getAttribute("data-position")).toBe("center");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);

    expect(controller.skipAll).not.toHaveBeenCalled();
    expect(screen.getByTestId("permission-priming-modal")).toBeTruthy();
  });

  it("shows the recovery callout for a denied card and routes recovery through the controller", async () => {
    const controller = makeController({
      items: [item("microphone", "denied", false)],
      active: item("microphone", "denied", false),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    expect(screen.getByTestId("priming-recovery-microphone")).toBeTruthy();
    // canRequest === false → the retry action re-checks status (post-Settings).
    await act(async () => {
      fireEvent.click(screen.getByTestId("priming-recovery-microphone-retry"));
    });
    expect(controller.recheck).toHaveBeenCalledWith("microphone");
    expect(controller.request).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(
        screen.getByTestId("priming-recovery-microphone-settings"),
      );
    });
    expect(controller.openSettings).toHaveBeenCalledWith("microphone");
  });

  it("surfaces a native Settings launch failure in the recovery card", async () => {
    const controller = makeController({
      items: [item("notifications", "denied", false)],
      active: item("notifications", "denied", false),
      totalSteps: 1,
      openSettings: vi.fn(async () => {
        throw new Error("open exited 1");
      }),
    });
    render(
      <PermissionPrimingModal
        open
        onComplete={vi.fn()}
        ids={["notifications"]}
        controllerOverride={controller}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByTestId("priming-recovery-notifications-settings"),
      );
    });

    expect(
      screen.getByTestId("priming-recovery-notifications-settings-error")
        .textContent,
    ).toContain("Couldn’t open Settings");
  });

  it("a denied card that can still re-prompt retries via request()", async () => {
    const controller = makeController({
      items: [item("location", "denied", true)],
      active: item("location", "denied", true),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["location"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("priming-recovery-location-retry"));
    });
    expect(controller.request).toHaveBeenCalledWith("location");
  });

  it("labels a platform request failure as an error rather than a user denial", async () => {
    const failed = {
      ...item("notifications", "unknown", true),
      requestError: true,
    };
    const controller = makeController({ items: [failed], active: failed });
    renderModal(
      <PermissionPrimingModal
        ids={["notifications"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    expect(screen.getByText("Couldn’t request permission")).toBeTruthy();
    expect(screen.queryByText("Permission was declined")).toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("priming-recovery-notifications-retry"),
      );
    });
    expect(controller.request).toHaveBeenCalledWith("notifications");
  });

  it("surfaces a failed post-Settings re-check and retries the re-check", async () => {
    const failed = {
      ...item("notifications", "denied", false),
      recheckError: true,
    };
    const controller = makeController({ items: [failed], active: failed });
    renderModal(
      <PermissionPrimingModal
        ids={["notifications"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );

    expect(screen.getByText("Couldn’t verify permission")).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("priming-recovery-notifications-retry"),
      );
    });
    expect(controller.recheck).toHaveBeenCalledWith("notifications");
    expect(controller.request).not.toHaveBeenCalled();
  });

  it("renders a loading state until the initial check completes", () => {
    const controller = makeController({ ready: false, active: null });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );
    expect(screen.getByTestId("permission-priming-loading")).toBeTruthy();
  });

  it("calls onComplete exactly once when the sequence is done", () => {
    const onComplete = vi.fn();
    const controller = makeController({
      ready: true,
      done: true,
      active: null,
    });
    const { rerender } = renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={onComplete}
        controllerOverride={controller}
      />,
    );
    rerender(
      <MockAppProvider>
        <PermissionPrimingModal
          ids={["microphone"]}
          open
          onComplete={onComplete}
          controllerOverride={controller}
        />
      </MockAppProvider>,
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Not now skips the whole flow", () => {
    const controller = makeController({
      items: [item("microphone", "not-determined", true)],
      active: item("microphone", "not-determined", true),
    });
    renderModal(
      <PermissionPrimingModal
        ids={["microphone"]}
        open
        onComplete={vi.fn()}
        controllerOverride={controller}
      />,
    );
    fireEvent.click(screen.getByTestId("priming-skip-all"));
    expect(controller.skipAll).toHaveBeenCalled();
  });
});
