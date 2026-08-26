/** Coordinates fresh app state, ephemeral element indices, semantic-first execution, and verified receipts. */

import { randomUUID } from "node:crypto";
import type {
  AppActionOutcome,
  AppActionRequest,
  AppControlAdapter,
  AppControlGrounder,
  AppControlPermissionState,
  AppDescriptor,
  AppElement,
  AppExactWindowPointerDispatcher,
  AppState,
  AppStateCapture,
  NativeAppElement,
  PhysicalPointerDriver,
  PhysicalPointerObserver,
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
  pointerObserver?: PhysicalPointerObserver;
  exactWindowPointer?: AppExactWindowPointerDispatcher;
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

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isTargetOrDescendant(
  locator: number[],
  targetLocator: number[],
): boolean {
  return targetLocator.every((part, index) => locator[index] === part);
}

function targetReadbackSignature(
  elements: NativeAppElement[],
  target: NativeAppElement,
  kind: "click" | "scroll",
): string {
  return JSON.stringify(
    elements
      .filter((element) =>
        isTargetOrDescendant(element.locator, target.locator),
      )
      .map((element) => ({
        locator: element.locator.slice(target.locator.length),
        role: element.role,
        subrole: element.subrole,
        label: element.label,
        description: element.description,
        value: element.secure ? undefined : element.value,
        bounds: element.bounds,
        ...(kind === "click"
          ? {
              actions: element.actions,
              enabled: element.enabled,
              focused: element.focused,
              selected: element.selected,
            }
          : {}),
      })),
  );
}

export class AppControlCoordinator {
  private readonly states = new Map<string, StoredState>();
  private readonly adapter: AppControlAdapter;
  private readonly capture: AppStateCapture;
  private readonly grounder?: AppControlGrounder;
  private readonly pointer?: PhysicalPointerDriver;
  private readonly pointerObserver?: PhysicalPointerObserver;
  private readonly exactWindowPointer?: AppExactWindowPointerDispatcher;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private permission: AppControlPermissionState | "unknown" = "unknown";

  constructor(options: AppControlCoordinatorOptions) {
    this.adapter = options.adapter;
    this.capture = options.capture;
    this.grounder = options.grounder;
    this.pointer = options.pointer;
    this.pointerObserver = options.pointerObserver;
    this.exactWindowPointer = options.exactWindowPointer;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  readiness(): {
    available: boolean;
    adapter: string;
    permission: AppControlPermissionState | "unknown";
  } {
    const available = this.adapter.available();
    return {
      available,
      adapter: this.adapter.name,
      permission: available ? this.permission : "helper_unavailable",
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
    // Semantic AX owns the first attempt; experimental delivery is never a shortcut.
    let nativeResult =
      request.kind === "hover_target"
        ? { success: true }
        : await this.adapter.perform(
            stored.publicState.app,
            element,
            request,
            signal,
          );
    if (
      !nativeResult.success &&
      request.allowExperimentalExactWindow &&
      this.exactWindowPointer?.available() &&
      element &&
      (request.kind === "click" || request.kind === "scroll")
    ) {
      if (stored.publicState.focusedWindowId === undefined) {
        return {
          success: false,
          error:
            "Experimental exact-window dispatch requires an exact window binding",
        };
      }
      const freshState = await this.getAppState(request.app, {
        disableDiff: true,
        signal,
      });
      const fresh = this.states.get(request.app);
      const freshElement = request.element_index
        ? fresh?.nativeElements[request.element_index - 1]
        : undefined;
      if (
        !fresh ||
        freshState.app.pid !== stored.publicState.app.pid ||
        freshState.focusedWindowId !== stored.publicState.focusedWindowId ||
        !sameValue(
          freshState.screenshotBounds,
          stored.publicState.screenshotBounds,
        ) ||
        !freshElement ||
        !sameValue(freshElement.locator, element.locator) ||
        !sameValue(freshElement.bounds, element.bounds)
      ) {
        return {
          success: false,
          error:
            "Experimental exact-window target changed during pre-dispatch recapture",
        };
      }
      let pointerBefore: { x: number; y: number };
      try {
        if (!this.pointerObserver) throw new Error("observer unavailable");
        pointerBefore = await this.pointerObserver.position();
      } catch {
        // error-policy:J4 experimental dispatch visibly refuses when independent
        // physical-pointer provenance cannot be established.
        return {
          success: false,
          error:
            "Experimental exact-window dispatch requires physical pointer provenance",
        };
      }
      const postedUnconfirmed = (
        diagnostic: NonNullable<
          NonNullable<AppActionOutcome["receipt"]>["effectDiagnostic"]
        >,
        observedState = freshState,
        physicalPointerMoved = false,
      ): AppActionOutcome => ({
        success: true,
        state: observedState,
        receipt: {
          receiptId: this.idFactory(),
          appId: request.app,
          kind: request.kind,
          beforeStateId: freshState.stateId,
          afterStateId: observedState.stateId,
          executionMode: "experimental_direct_exact_window",
          ...(request.element_index !== undefined
            ? { element_index: request.element_index }
            : {}),
          completedAt: new Date(this.now()).toISOString(),
          effectStatus: "posted_unconfirmed",
          effectDiagnostic: diagnostic,
          changed: false,
          physicalPointerMoved,
          targetBounds: freshElement.bounds,
        },
      });
      const result = await this.exactWindowPointer.dispatch(
        {
          app: freshState.app,
          state: freshState,
          element: freshElement,
          request,
          expectedWindowId: freshState.focusedWindowId,
        },
        signal,
      );
      let pointerAfter: { x: number; y: number };
      try {
        pointerAfter = await this.pointerObserver.position();
      } catch (error) {
        // error-policy:J4 the effect may already be posted, so observation
        // failure is explicit and non-retryable rather than a false refusal.
        return postedUnconfirmed({
          code: "POST_DISPATCH_POINTER_UNAVAILABLE",
          message:
            "Experimental exact-window dispatch posted but pointer stability could not be observed",
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      if (!result.success) {
        return {
          success: false,
          error:
            result.error ?? "Experimental exact-window helper refused dispatch",
        };
      }
      if (
        result.observationId !== freshState.stateId ||
        result.targetPid !== freshState.app.pid ||
        result.targetWindowId !== freshState.focusedWindowId ||
        !freshState.screenshotBounds ||
        JSON.stringify(result.targetWindowBounds) !==
          JSON.stringify(freshState.screenshotBounds) ||
        result.pointerBefore.x !== result.pointerAfter.x ||
        result.pointerBefore.y !== result.pointerAfter.y ||
        !sameValue(result.pointerBefore, pointerBefore) ||
        !sameValue(result.pointerAfter, pointerAfter) ||
        !sameValue(pointerBefore, pointerAfter)
      ) {
        const pointerChanged = !sameValue(pointerBefore, pointerAfter);
        return postedUnconfirmed(
          {
            code: pointerChanged
              ? "POST_DISPATCH_POINTER_CHANGED"
              : "POST_DISPATCH_RECEIPT_UNVERIFIED",
            message: pointerChanged
              ? "Experimental exact-window dispatch posted while the physical pointer changed"
              : "Experimental exact-window dispatch posted but its receipt provenance could not be verified",
            ...(result.error ? { cause: result.error } : {}),
          },
          freshState,
          pointerChanged,
        );
      }
      let after: AppState;
      try {
        after = await this.getAppState(request.app, { signal });
      } catch (error) {
        // error-policy:J4 dispatch completion is retained when post-state
        // observation fails, preventing an unsafe retry of the posted effect.
        return postedUnconfirmed({
          code: "POST_DISPATCH_STATE_UNAVAILABLE",
          message:
            "Experimental exact-window dispatch posted but post-state observation failed",
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      const afterNative = this.states.get(request.app)?.nativeElements;
      const sameWindow =
        after.app.pid === freshState.app.pid &&
        after.focusedWindowId === freshState.focusedWindowId &&
        sameValue(after.screenshotBounds, freshState.screenshotBounds);
      const targetChanged =
        sameWindow &&
        afterNative !== undefined &&
        targetReadbackSignature(
          fresh.nativeElements,
          freshElement,
          request.kind,
        ) !== targetReadbackSignature(afterNative, freshElement, request.kind);
      if (!targetChanged) {
        return postedUnconfirmed(
          {
            code: "POST_DISPATCH_TARGET_UNCONFIRMED",
            message: sameWindow
              ? "Experimental exact-window dispatch posted without target-local semantic readback"
              : "Experimental exact-window dispatch posted but the target window changed before readback",
          },
          after,
        );
      }
      return {
        success: true,
        state: after,
        receipt: {
          receiptId: this.idFactory(),
          appId: request.app,
          kind: request.kind,
          beforeStateId: freshState.stateId,
          afterStateId: after.stateId,
          executionMode: "experimental_direct_exact_window",
          ...(request.element_index !== undefined
            ? { element_index: request.element_index }
            : {}),
          completedAt: new Date(this.now()).toISOString(),
          effectStatus: "confirmed",
          changed: true,
          physicalPointerMoved: false,
          targetBounds: freshElement.bounds,
        },
      };
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
      const after = await this.getAppState(request.app, { signal });
      return {
        success: true,
        state: after,
        receipt: {
          receiptId: this.idFactory(),
          appId: request.app,
          kind: request.kind,
          beforeStateId: request.stateId,
          afterStateId: after.stateId,
          executionMode: "agent_overlay",
          ...(request.element_index !== undefined
            ? { element_index: request.element_index }
            : {}),
          completedAt: new Date(this.now()).toISOString(),
          effectStatus: "confirmed",
          changed: false,
          physicalPointerMoved: false,
          ...(element?.bounds ? { targetBounds: element.bounds } : {}),
        },
      };
    }

    let executionMode:
      | "semantic_ax"
      | "set_of_marks"
      | "ocr"
      | "guarded_physical" = "semantic_ax";
    let physicalPointerMoved = false;

    if (!nativeResult.success) {
      const match = await this.grounder?.ground(
        stored.publicState,
        request,
        signal,
      );
      if (match) {
        if (!request.allowPhysicalFallback || !this.pointer) {
          throw new AppControlError(
            "PHYSICAL_FALLBACK_DENIED",
            "Visual grounding found a target, but canonical policy did not authorize physical pointer injection",
          );
        }
        executionMode = match.mode;
        if (request.kind === "click") {
          await this.pointer.click(match.x, match.y);
        } else if (request.kind === "scroll") {
          await this.pointer.scroll(
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
        physicalPointerMoved = true;
        nativeResult = { success: true };
      } else if (
        request.allowPhysicalFallback &&
        this.pointer &&
        element?.bounds
      ) {
        const x = element.bounds.x + element.bounds.width / 2;
        const y = element.bounds.y + element.bounds.height / 2;
        executionMode = "guarded_physical";
        if (request.kind === "click") await this.pointer.click(x, y);
        else if (request.kind === "scroll") {
          await this.pointer.scroll(
            x,
            y,
            request.direction ?? "down",
            request.amount ?? 3,
          );
        } else {
          return { success: false, error: nativeResult.error };
        }
        physicalPointerMoved = true;
        nativeResult = { success: true };
      }
    }
    if (!nativeResult.success)
      return { success: false, error: nativeResult.error };

    const after = await this.getAppState(request.app, { signal });
    const changed =
      stored.publicState.axText !== after.axText ||
      stored.publicState.screenshot !== after.screenshot;
    return {
      success: true,
      state: after,
      receipt: {
        receiptId: this.idFactory(),
        appId: request.app,
        kind: request.kind,
        beforeStateId: request.stateId,
        afterStateId: after.stateId,
        executionMode,
        ...(request.element_index !== undefined
          ? { element_index: request.element_index }
          : {}),
        completedAt: new Date(this.now()).toISOString(),
        effectStatus: "confirmed",
        changed,
        physicalPointerMoved,
        ...(element?.bounds ? { targetBounds: element.bounds } : {}),
        ...(nativeResult.clipboardRestored !== undefined
          ? { clipboardRestored: nativeResult.clipboardRestored }
          : {}),
      },
    };
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
