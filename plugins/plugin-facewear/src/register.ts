// Direct subpath: the app renderer resolves the bare `@elizaos/ui` root to the
// browser barrel, which doesn't reliably re-export this registry helper.

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { registerSettingsSection } from "@elizaos/ui/components/settings/settings-section-registry";
import { Glasses } from "lucide-react";
import { type ComponentType, createElement, useEffect, useState } from "react";

type DeferredViewComponent = ComponentType<Record<string, unknown>>;
type DeferredViewModule = { default: DeferredViewComponent };
type DeferredViewLoader = () => Promise<DeferredViewModule>;

function loadFacewearAppView(): Promise<DeferredViewModule> {
  return import("./ui/FacewearAppView.tsx").then((module) => ({
    default: module.FacewearAppView as DeferredViewComponent,
  }));
}

function loadFacewearTuiView(): Promise<DeferredViewModule> {
  return import("./ui/FacewearAppView.tsx").then((module) => ({
    default: module.FacewearTuiView as DeferredViewComponent,
  }));
}

function loadSmartglassesView(): Promise<DeferredViewModule> {
  return import("./ui/SmartglassesView.tsx").then((module) => ({
    default: module.SmartglassesView as DeferredViewComponent,
  }));
}

function loadSmartglassesTuiView(): Promise<DeferredViewModule> {
  return import("./ui/FacewearAppView.tsx").then((module) => ({
    default: module.SmartglassesTuiView as DeferredViewComponent,
  }));
}

function deferredComponent(loader: DeferredViewLoader): DeferredViewComponent {
  let cached: DeferredViewComponent | null = null;
  let pending: Promise<DeferredViewComponent> | null = null;

  function load(): Promise<DeferredViewComponent> {
    if (cached) return Promise.resolve(cached);
    pending ??= loader().then(
      (module) => {
        cached = module.default;
        return cached;
      },
      (error) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  }

  return function DeferredComponent(props: Record<string, unknown>) {
    const [Component, setComponent] = useState<DeferredViewComponent | null>(
      cached,
    );

    useEffect(() => {
      if (Component) return;
      let cancelled = false;
      void load()
        .then((nextComponent) => {
          if (!cancelled) setComponent(() => nextComponent);
        })
        .catch(() => {
          if (!cancelled) setComponent(null);
        });
      return () => {
        cancelled = true;
      };
    }, [Component]);

    return Component ? createElement(Component, props) : null;
  };
}

export const FacewearAppView = deferredComponent(loadFacewearAppView);
export const FacewearTuiView = deferredComponent(loadFacewearTuiView);
export const SmartglassesView = deferredComponent(loadSmartglassesView);
export const SmartglassesTuiView = deferredComponent(loadSmartglassesTuiView);

function FacewearSettingsSection() {
  const [active, setActive] = useState<"devices" | "smartglasses">("devices");
  const tabClassName = (selected: boolean) =>
    `h-8 rounded-sm px-3 text-xs font-medium transition-colors ${
      selected ? "bg-bg text-txt-strong shadow-sm" : "text-muted hover:text-txt"
    }`;

  return createElement(
    "div",
    { className: "flex min-h-[34rem] min-w-0 flex-col gap-3" },
    createElement(
      "div",
      {
        role: "tablist",
        "aria-label": "Facewear settings",
        className:
          "inline-flex w-fit items-center gap-1 rounded-md bg-surface p-1",
      },
      createElement(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": active === "devices",
          onClick: () => setActive("devices"),
          className: tabClassName(active === "devices"),
        },
        "Devices",
      ),
      createElement(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": active === "smartglasses",
          onClick: () => setActive("smartglasses"),
          className: tabClassName(active === "smartglasses"),
        },
        "Smartglasses",
      ),
    ),
    createElement(
      "div",
      { className: "min-h-0 min-w-0 flex-1 overflow-hidden" },
      active === "devices"
        ? createElement(FacewearAppView, {
            onOpenSmartglasses: () => setActive("smartglasses"),
            embedded: true,
          })
        : createElement(SmartglassesView),
    ),
  );
}

registerSettingsSection({
  id: "facewear",
  label: "settings.sections.facewear.label",
  defaultLabel: "Facewear",
  icon: Glasses,
  tone: "accent",
  hue: "slate",
  group: "system",
  titleKey: "settings.sections.facewear.title",
  defaultTitle: "Facewear & Smartglasses",
  order: 6.5,
  viewKind: "system",
  bodyClassName: "min-h-0",
  Component: FacewearSettingsSection,
});

registerAppShellPage({
  id: "facewear.tui",
  pluginId: "@elizaos/plugin-facewear",
  label: "Facewear TUI",
  viewKind: "preview",
  icon: "Terminal",
  path: "/apps/facewear/tui",
  order: 80.1,
  group: "hardware",
  loader: loadFacewearTuiView,
});

registerAppShellPage({
  id: "facewear",
  pluginId: "@elizaos/plugin-facewear",
  label: "Facewear",
  viewKind: "preview",
  icon: "Glasses",
  path: "/apps/facewear",
  order: 80,
  group: "hardware",
  loader: loadFacewearAppView,
});

registerAppShellPage({
  id: "smartglasses.tui",
  pluginId: "@elizaos/plugin-facewear",
  label: "Smartglasses TUI",
  viewKind: "preview",
  icon: "Terminal",
  path: "/apps/smartglasses/tui",
  order: 81.1,
  group: "hardware",
  loader: loadSmartglassesTuiView,
});

registerAppShellPage({
  id: "smartglasses",
  pluginId: "@elizaos/plugin-facewear",
  label: "Smartglasses",
  viewKind: "preview",
  icon: "Glasses",
  path: "/apps/smartglasses",
  order: 81,
  group: "hardware",
  loader: loadSmartglassesView,
});

// In a terminal host (the Node agent, no DOM), register the facewear and
// smartglasses views so they render inline in the terminal as the unified
// FacewearSpatialView / SmartglassesSpatialView.
// Lazy + DOM-guarded so the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view.tsx")
    .then((m) => {
      m.registerFacewearTerminalView();
      m.registerSmartglassesTerminalView();
    })
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
