/** Coordinates fresh app state, ephemeral element indices, semantic-first execution, and verified receipts. */

import { randomUUID } from "node:crypto";
import {
  getAppControlRouteMatrix,
  type AppControlRouteCapability,
} from "./route-policy.js";
import type {
  AppActionOutcome,
  AppActionRequest,
  AppControlAdapter,
  AppControlGrounder,
  AppControlPermissionState,
  AppDescriptor,
  AppElement,
  AppPointerObserver,
  AppPointerPosition,
  AppState,
  AppStateCapture,
  NativeAppElement,
  PhysicalFallbackApprovalReceipt,
  PhysicalFallbackAuthorizer,
  PhysicalPointerDriver,
} from "./types.js";

export class AppControlError extends Error {
  constructor(
    readonly code:
      | "APP_CONTROL_UNAVAILABLE"
      | "APP_NOT_FOUND"
      | "APP_PERMISSION_DENIED"
      | "STALE_APP_STATE"
      | "ELEMENT_NOT_FOUND"
      | "ACTION_NOT_EXPOSED"
      | "PHYSICAL_FALLBACK_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "AppControlError";
  }
}

interface StoredState {
  publicState: AppState;
  nativeElements: NativeAppElement[];
}

interface AppControlCoordinatorOptions {
  adapter: AppControlAdapter;
  capture: AppStateCapture;
  grounder?: AppControlGrounder;
  pointer?: PhysicalPointerDriver;
  pointerObserver?: AppPointerObserver;
  authorizePhysicalFallback?: PhysicalFallbackAuthorizer;
  now?: () => number;
  idFactory?: () => string;
}

function publicElements(elements: NativeAppElement[]): AppElement[] {
  return elements.map(({ locator: _locator, ...element }, index) => ({
    ...element,
    element_index: index + 1,
  }));
}

function elementSignature(element: AppElement): string {
  return JSON.stringify({
    role: element.role,
    subrole: element.subrole,
    label: element.label,
    value: element.secure ? undefined : element.value,
    description: element.description,
    bounds: element.bounds,
    actions: element.actions,
    enabled: element.enabled,
    focused: element.focused,
    selected: element.selected,
  });
}

function makeDiff(previous: AppState, next: AppState): AppState["diff"] {
  const previousBySignature = new Map(
    previous.elements.map((element) => [elementSignature(element), element]),
  );
  const nextBySignature = new Map(
    next.elements.map((element) => [elementSignature(element), element]),
  );
  return {
    baseStateId: previous.stateId,
    added: next.elements
      .filter((element) => !previousBySignature.has(elementSignature(element)))
      .map((element) => element.element_index),
    changed: next.elements
      .filter((element, index) => {
        const prior = previous.elements[index];
        return (
          prior !== undefined &&
          elementSignature(prior) !== elementSignature(element)
        );
      })
      .map((element) => element.element_index),
    removed: previous.elements
      .filter((element) => !nextBySignature.has(elementSignature(element)))
      .map((element) => element.element_index),
    axTextChanged: previous.axText !== next.axText,
  };
}

export class AppControlCoordinator {
  private readonly states = new Map<string, StoredState>();
  private readonly adapter: AppControlAdapter;
  private readonly capture: AppStateCapture;
  private readonly grounder?: AppControlGrounder;
  private readonly pointer?: PhysicalPointerDriver;
  private readonly pointerObserver?: AppPointerObserver;
  private readonly authorizePhysicalFallback?: PhysicalFallbackAuthorizer;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private permission: AppControlPermissionState | "unknown" = "unknown";

  constructor(options: AppControlCoordinatorOptions) {
    this.adapter = options.adapter;
    this.capture = options.capture;
    this.grounder = options.grounder;
    this.pointer = options.pointer;
    this.pointerObserver = options.pointerObserver;
    this.authorizePhysicalFallback = options.authorizePhysicalFallback;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  readiness(): {
    available: boolean;
    adapter: string;
    permission: AppControlPermissionState | "unknown";
    routes: AppControlRouteCapability[];
  } {
    const available = this.adapter.available();
    return {
      available,
      adapter: this.adapter.name,
      permission: available ? this.permission : "helper_unavailable",
      routes: getAppControlRouteMatrix(),
    };
  }

  async listApps(signal?: AbortSignal): Promise<AppDescriptor[]> {
    if (!this.adapter.available()) {
      throw new AppControlError(
        "APP_CONTROL_UNAVAILABLE",
        "Native app accessibility control is unavailable on this host",
      );
    }
    return this.adapter.listApps(signal);
  }

  async getAppState(
    app: string,
    options: { disableDiff?: boolean; signal?: AbortSignal } = {},
  ): Promise<AppState> {
    if (!this.adapter.available()) {
      throw new AppControlError(
        "APP_CONTROL_UNAVAILABLE",
        "Native app accessibility control is unavailable on this host",
      );
    }
    const native = await this.adapter.snapshot(app, options.signal);
    this.permission = native.permission;
    if (native.permission !== "ready") {
      throw new AppControlError(
        "APP_PERMISSION_DENIED",
        native.permission === "accessibility_denied"
          ? "macOS Accessibility permission is required; permission was not requested or changed"
          : native.permission === "screen_recording_denied"
            ? "macOS Screen Recording permission is required; permission was not requested or changed"
            : "The packaged macOS accessibility helper is unavailable",
      );
    }
    const captured = await this.capture.capture(native, options.signal);
    const state: AppState = {
      stateId: `${native.app.id}:${this.idFactory()}`,
      app: native.app,
      capturedAt: native.capturedAt,
      permission: native.permission,
      elements: publicElements(native.elements),
      axText: native.axText,
      ...(captured
        ? {
            screenshot: captured.screenshot,
            screenshotMimeType: "image/png" as const,
            displayId: captured.displayId,
            screenshotBounds: captured.bounds,
          }
        : {}),
      ...(native.focusedWindowId !== undefined
        ? { focusedWindowId: native.focusedWindowId }
        : {}),
    };
    const previous = this.states.get(native.app.id)?.publicState;
    if (previous && !options.disableDiff)
      state.diff = makeDiff(previous, state);
    this.states.set(native.app.id, {
      publicState: state,
      nativeElements: native.elements,
    });
    return state;
  }

  async act(
    request: AppActionRequest,
    signal?: AbortSignal,
  ): Promise<AppActionOutcome> {
    const stored = [...this.states.values()].find(
      ({ publicState }) => publicState.stateId === request.stateId,
    );
    if (!stored || stored.publicState.app.id !== request.app) {
      throw new AppControlError(
        "STALE_APP_STATE",
        "element_index is ephemeral; call get_app_state and retry with the newest stateId",
      );
    }
    const latest = this.states.get(request.app);
    if (latest?.publicState.stateId !== request.stateId) {
      throw new AppControlError(
        "STALE_APP_STATE",
        "The app changed or was recaptured; call get_app_state before acting",
      );
    }
    const element = this.resolveElement(stored, request);
    const expectedWindowId = stored.publicState.focusedWindowId;
    if (expectedWindowId === undefined) {
      throw new AppControlError(
        "STALE_APP_STATE",
        "The app state is not bound to an exact focused window; recapture after the target window is ready",
      );
    }
    if (request.kind === "secondary_action") {
      const action = request.secondaryAction?.trim();
      if (!action || !element?.actions.includes(action)) {
        throw new AppControlError(
          "ACTION_NOT_EXPOSED",
          "The requested secondary action is not exposed by this element",
        );
      }
    }

    if (request.kind === "hover_target") {
      const pointerBefore = await this.readPointerPosition();
      const after = await this.getAppState(request.app, { signal });
      if (after.focusedWindowId !== expectedWindowId) {
        return {
          success: false,
          error:
            "The exact target window changed before the overlay could be verified",
          state: after,
        };
      }
      const pointerAfter = await this.readPointerPosition();
      const pointerObservation = this.pointerObservation(
        pointerBefore,
        pointerAfter,
      );
      return {
        success: true,
        state: after,
        receipt: {
          receiptId: this.idFactory(),
          appId: request.app,
          kind: request.kind,
          beforeStateId: request.stateId,
          afterStateId: after.stateId,
          targetPid: stored.publicState.app.pid,
          targetWindowId: expectedWindowId,
          executionMode: "agent_overlay",
          ...(request.element_index !== undefined
            ? { element_index: request.element_index }
            : {}),
          completedAt: new Date(this.now()).toISOString(),
          changed: false,
          physicalPointerInput: false,
          physicalPointerMoved: pointerObservation === "changed",
          pointerObservation,
          ...(pointerBefore ? { pointerBefore } : {}),
          ...(pointerAfter ? { pointerAfter } : {}),
          ...(element?.bounds ? { targetBounds: element.bounds } : {}),
        },
      };
    }

    const pointerBefore = await this.readPointerPosition();
    let executionMode:
      | "semantic_ax"
      | "process_pid_keyboard_cgevent"
      | "guarded_physical" = "semantic_ax";
    let nativeResult = await this.adapter.perform(
      stored.publicState.app,
      element,
      request,
      expectedWindowId,
      signal,
    );
    if (
      nativeResult.targetPid !== stored.publicState.app.pid ||
      nativeResult.targetWindowId !== expectedWindowId
    ) {
      return {
        success: false,
        error:
          "The native action result was not bound to the requested PID and CGWindowID",
      };
    }
    executionMode = nativeResult.executionMode ?? "semantic_ax";
    let physicalPointerInput = false;
    let groundingMode: "set_of_marks" | "ocr" | "element_bounds" | undefined;
    let fallbackApproval: PhysicalFallbackApprovalReceipt | undefined;

    if (!nativeResult.success) {
      const match = await this.grounder?.ground(
        stored.publicState,
        request,
        signal,
      );
      if (match) {
        fallbackApproval = await this.approvePhysicalFallback(
          request,
          {
            x: match.x,
            y: match.y,
            groundingMode: match.mode,
          },
          signal,
        );
        executionMode = "guarded_physical";
        groundingMode = match.mode;
        if (request.kind === "click") {
          await this.pointer?.click(match.x, match.y);
        } else if (request.kind === "scroll") {
          await this.pointer?.scroll(
            match.x,
            match.y,
            request.direction ?? "down",
            request.amount ?? 3,
          );
        } else {
          throw new AppControlError(
            "PHYSICAL_FALLBACK_DENIED",
            `Physical fallback is not supported for ${request.kind}`,
          );
        }
        physicalPointerInput = true;
        nativeResult = {
          success: true,
          targetPid: stored.publicState.app.pid,
          targetWindowId: expectedWindowId,
        };
      } else if (
        request.allowPhysicalFallback &&
        this.pointer &&
        element?.bounds
      ) {
        const x = element.bounds.x + element.bounds.width / 2;
        const y = element.bounds.y + element.bounds.height / 2;
        fallbackApproval = await this.approvePhysicalFallback(
          request,
          {
            x,
            y,
            groundingMode: "element_bounds",
          },
          signal,
        );
        executionMode = "guarded_physical";
        groundingMode = "element_bounds";
        if (request.kind === "click") await this.pointer?.click(x, y);
        else if (request.kind === "scroll") {
          await this.pointer?.scroll(
            x,
            y,
            request.direction ?? "down",
            request.amount ?? 3,
          );
        } else {
          return { success: false, error: nativeResult.error };
        }
        physicalPointerInput = true;
        nativeResult = {
          success: true,
          targetPid: stored.publicState.app.pid,
          targetWindowId: expectedWindowId,
        };
      }
    }
    if (!nativeResult.success)
      return { success: false, error: nativeResult.error };

    const after = await this.getAppState(request.app, { signal });
    const pointerAfter = await this.readPointerPosition();
    const pointerObservation = this.pointerObservation(
      pointerBefore,
      pointerAfter,
    );
    const changed =
      stored.publicState.axText !== after.axText ||
      stored.publicState.screenshot !== after.screenshot;
    const afterElement = element
      ? this.states
          .get(request.app)
          ?.nativeElements.find((candidate) =>
            this.sameLocator(candidate.locator, element.locator),
          )
      : undefined;
    const targetChanged = this.targetElementChanged(element, afterElement);
    if (after.focusedWindowId !== expectedWindowId) {
      return {
        success: false,
        error:
          "The exact target window changed during the action; sibling-window state cannot verify delivery",
        state: after,
      };
    }
    if (
      executionMode === "process_pid_keyboard_cgevent" &&
      !targetChanged
    ) {
      return {
        success: false,
        error:
          "Process-scoped PID event delivery could not be verified by target-element readback in the exact bound window",
        state: after,
      };
    }
    return {
      success: true,
      state: after,
      receipt: {
        receiptId: this.idFactory(),
        appId: request.app,
        kind: request.kind,
        beforeStateId: request.stateId,
        afterStateId: after.stateId,
        targetPid: stored.publicState.app.pid,
        targetWindowId: expectedWindowId,
        executionMode,
        ...(request.element_index !== undefined
          ? { element_index: request.element_index }
          : {}),
        completedAt: new Date(this.now()).toISOString(),
        changed,
        physicalPointerInput,
        physicalPointerMoved: pointerObservation === "changed",
        pointerObservation,
        ...(pointerBefore ? { pointerBefore } : {}),
        ...(pointerAfter ? { pointerAfter } : {}),
        ...(groundingMode ? { groundingMode } : {}),
        ...(fallbackApproval
          ? { physicalFallbackApproval: fallbackApproval }
          : {}),
        ...(element?.bounds ? { targetBounds: element.bounds } : {}),
        ...(nativeResult.clipboardRestored !== undefined
          ? { clipboardRestored: nativeResult.clipboardRestored }
          : {}),
      },
    };
  }

  private async approvePhysicalFallback(
    request: AppActionRequest,
    target: AppPointerPosition & {
      groundingMode: "set_of_marks" | "ocr" | "element_bounds";
    },
    signal?: AbortSignal,
  ): Promise<PhysicalFallbackApprovalReceipt> {
    if (
      !request.allowPhysicalFallback ||
      !this.pointer ||
      !this.authorizePhysicalFallback ||
      request.element_index === undefined ||
      (request.kind !== "click" && request.kind !== "scroll")
    ) {
      throw new AppControlError(
        "PHYSICAL_FALLBACK_DENIED",
        "A target was grounded, but physical input requires a distinct action-time approval",
      );
    }
    const pointer = await this.readPointerPosition();
    if (!pointer) {
      throw new AppControlError(
        "PHYSICAL_FALLBACK_DENIED",
        "Physical input was blocked because pointer provenance is unavailable",
      );
    }
    return this.authorizePhysicalFallback(
      {
        appId: request.app,
        kind: request.kind,
        element_index: request.element_index,
        groundingMode: target.groundingMode,
        target: { x: target.x, y: target.y },
      },
      signal,
    );
  }

  private async readPointerPosition(): Promise<AppPointerPosition | undefined> {
    if (!this.pointerObserver) return undefined;
    try {
      const position = await this.pointerObserver.getPosition();
      return Number.isFinite(position.x) && Number.isFinite(position.y)
        ? position
        : undefined;
    } catch {
      // error-policy:J4 pointer provenance is explicit as unavailable; a
      // physical fallback still fails closed in approvePhysicalFallback.
      return undefined;
    }
  }

  private pointerObservation(
    before: AppPointerPosition | undefined,
    after: AppPointerPosition | undefined,
  ): "unchanged" | "changed" | "unavailable" {
    if (!before || !after) return "unavailable";
    return before.x === after.x && before.y === after.y
      ? "unchanged"
      : "changed";
  }

  private targetElementChanged(
    before: NativeAppElement | undefined,
    after: NativeAppElement | undefined,
  ): boolean {
    if (!before) return false;
    if (!after) return true;
    return (
      before.role !== after.role ||
      before.label !== after.label ||
      before.value !== after.value ||
      before.enabled !== after.enabled ||
      before.focused !== after.focused ||
      before.selected !== after.selected
    );
  }

  private sameLocator(left: number[], right: number[]): boolean {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  private resolveElement(
    stored: StoredState,
    request: AppActionRequest,
  ): NativeAppElement | undefined {
    if (request.element_index === undefined) return undefined;
    if (
      !Number.isSafeInteger(request.element_index) ||
      request.element_index < 1
    ) {
      throw new AppControlError(
        "ELEMENT_NOT_FOUND",
        "element_index must be a positive integer from the latest app state",
      );
    }
    const element = stored.nativeElements[request.element_index - 1];
    if (!element) {
      throw new AppControlError(
        "ELEMENT_NOT_FOUND",
        "element_index does not exist in the latest app state",
      );
    }
    return element;
  }
}
