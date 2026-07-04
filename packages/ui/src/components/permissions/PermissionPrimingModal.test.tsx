// @vitest-environment jsdom
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  return { id, status, canRequest, requesting: false, resolved: false };
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
  it("renders the active card with rationale and Enable / Not now", () => {
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
    expect(screen.getByText("Talk to me")).toBeTruthy();
    expect(screen.getByTestId("priming-enable-microphone")).toBeTruthy();
    expect(screen.getByTestId("priming-skip-microphone")).toBeTruthy();
  });

  it("Enable fires the OS request, Not now skips without it", () => {
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
    expect(controller.skip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("priming-skip-microphone"));
    expect(controller.skip).toHaveBeenCalledWith("microphone");
  });

  it("shows the recovery callout for a denied card; retry re-checks when it can't re-prompt", () => {
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
    fireEvent.click(screen.getByTestId("priming-recovery-microphone-retry"));
    expect(controller.recheck).toHaveBeenCalledWith("microphone");
    expect(controller.request).not.toHaveBeenCalled();
  });

  it("a denied card that can still re-prompt retries via request()", () => {
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
    fireEvent.click(screen.getByTestId("priming-recovery-location-retry"));
    expect(controller.request).toHaveBeenCalledWith("location");
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

  it("Skip for now skips the whole flow", () => {
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
