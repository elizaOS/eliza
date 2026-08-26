/** Defines the truthful production support matrix for app-control dispatch routes. */

export type AppControlRouteId =
  | "semantic_ax"
  | "browser_cdp"
  | "process_pid_keyboard"
  | "exact_window_pointer"
  | "isolated_target"
  | "global_physical_pointer";

export type AppControlRouteStatus =
  | "supported"
  | "conditional"
  | "disabled_by_default"
  | "policy_blocked";

export type AppControlPointerEffect = "none" | "software_only" | "physical";

export interface AppControlRouteCapability {
  id: AppControlRouteId;
  status: AppControlRouteStatus;
  deliveryScope:
    | "accessibility_element"
    | "browser_target"
    | "process"
    | "window"
    | "isolated_guest"
    | "host_global";
  pointerEffect: AppControlPointerEffect;
  exactWindowDelivery: boolean;
  reason: string;
  requirements: string[];
}

export interface AppControlRoutePolicyOptions {
  globalPhysicalFallbackEnabled?: boolean;
  experimentalExactWindowComponentPresent?: boolean;
}

/**
 * Returns capabilities for the shared signed plugin bundle. The matrix does
 * not infer a private window dispatcher from PID-scoped event delivery.
 */
export function getAppControlRouteMatrix(
  options: AppControlRoutePolicyOptions = {},
): AppControlRouteCapability[] {
  const globalPhysicalFallbackEnabled =
    options.globalPhysicalFallbackEnabled ??
    process.env.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS === "1";
  const experimentalExactWindowComponentPresent =
    options.experimentalExactWindowComponentPresent ?? false;

  return [
    {
      id: "semantic_ax",
      status: "supported",
      deliveryScope: "accessibility_element",
      pointerEffect: "none",
      exactWindowDelivery: true,
      reason:
        "The indexed AX element is revalidated inside the exact bound accessibility window before dispatch.",
      requirements: [
        "Accessibility permission",
        "exact PID and CGWindowID binding",
        "element-exposed semantic action",
      ],
    },
    {
      id: "browser_cdp",
      status: "supported",
      deliveryScope: "browser_target",
      pointerEffect: "software_only",
      exactWindowDelivery: false,
      reason:
        "CDP addresses an exact browser target without host pointer injection; a browser target is not a CGWindowID.",
      requirements: ["registered CDP browser target", "target-bound readback"],
    },
    {
      id: "process_pid_keyboard",
      status: "conditional",
      deliveryScope: "process",
      pointerEffect: "none",
      exactWindowDelivery: false,
      reason:
        "PID keyboard delivery is process-scoped and succeeds only with one eligible same-PID window and target-element readback.",
      requirements: [
        "indexed target element",
        "one eligible same-PID window",
        "unchanged PID and CGWindowID binding",
        "action-specific target readback",
      ],
    },
    {
      id: "exact_window_pointer",
      status: experimentalExactWindowComponentPresent
        ? "disabled_by_default"
        : "policy_blocked",
      deliveryScope: "window",
      pointerEffect: "none",
      exactWindowDelivery: false,
      reason: experimentalExactWindowComponentPresent
        ? "A direct-only experimental component is present but requires explicit route selection, runtime probing, and signed acceptance before it can be treated as supported."
        : "The shared signed distribution has no public macOS CGWindowID-addressed pointer API; the optional private component is absent.",
      requirements: [
        "public supported window-addressed API or isolated non-store component",
        "signed-package acceptance",
        "action-specific target readback",
      ],
    },
    {
      id: "isolated_target",
      status: "conditional",
      deliveryScope: "isolated_guest",
      pointerEffect: "software_only",
      exactWindowDelivery: false,
      reason:
        "Sandbox and remote-guest control is supported when an isolated target backend supplies its own exact delivery and verification contract.",
      requirements: [
        "configured isolated backend",
        "target-bound observation",
        "backend action receipt",
      ],
    },
    {
      id: "global_physical_pointer",
      status: globalPhysicalFallbackEnabled
        ? "conditional"
        : "disabled_by_default",
      deliveryScope: "host_global",
      pointerEffect: "physical",
      exactWindowDelivery: false,
      reason: globalPhysicalFallbackEnabled
        ? "Global host input is available only as a supervised fallback with a distinct action-time approval."
        : "Global host input is disabled until the operator explicitly opts in; no app-control route may enable it implicitly.",
      requirements: [
        "operator environment opt-in",
        "explicit request",
        "pointer provenance",
        "distinct action-time approval",
      ],
    },
  ];
}
