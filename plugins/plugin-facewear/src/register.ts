import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { type ComponentType, createElement, useEffect, useState } from "react";

type DeferredViewComponent = ComponentType<Record<string, unknown>>;
type DeferredViewModule = { default: DeferredViewComponent };
type DeferredViewLoader = () => Promise<DeferredViewModule>;

function loadFacewearView(): Promise<DeferredViewModule> {
  return import("./ui/FacewearView.tsx").then((module) => ({
    default: module.FacewearView as DeferredViewComponent,
  }));
}

function loadFacewearTuiView(): Promise<DeferredViewModule> {
  return import("./ui/FacewearView.tsx").then((module) => ({
    default: module.FacewearTuiView as DeferredViewComponent,
  }));
}

function loadSmartglassesView(): Promise<DeferredViewModule> {
  return import("./ui/SmartglassesView.tsx").then((module) => ({
    default: module.SmartglassesView as DeferredViewComponent,
  }));
}

function loadSmartglassesTuiView(): Promise<DeferredViewModule> {
  return import("./ui/FacewearView.tsx").then((module) => ({
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

export const FacewearView = deferredComponent(loadFacewearView);
export const FacewearTuiView = deferredComponent(loadFacewearTuiView);
export const SmartglassesView = deferredComponent(loadSmartglassesView);
export const SmartglassesTuiView = deferredComponent(loadSmartglassesTuiView);

registerAppShellPage({
  id: "facewear",
  pluginId: "@elizaos/plugin-facewear",
  label: "Facewear",
  icon: "Glasses",
  path: "/apps/facewear",
  order: 80,
  group: "hardware",
  loader: loadFacewearView,
});

registerAppShellPage({
  id: "facewear.tui",
  pluginId: "@elizaos/plugin-facewear",
  label: "Facewear TUI",
  icon: "Terminal",
  path: "/apps/facewear/tui",
  order: 80.1,
  group: "hardware",
  loader: loadFacewearTuiView,
});

registerAppShellPage({
  id: "smartglasses",
  pluginId: "@elizaos/plugin-facewear",
  label: "Smartglasses",
  icon: "Glasses",
  path: "/apps/smartglasses",
  order: 81,
  group: "hardware",
  loader: loadSmartglassesView,
});

registerAppShellPage({
  id: "smartglasses.tui",
  pluginId: "@elizaos/plugin-facewear",
  label: "Smartglasses TUI",
  icon: "Terminal",
  path: "/apps/smartglasses/tui",
  order: 81.1,
  group: "hardware",
  loader: loadSmartglassesTuiView,
});

// In a terminal host (the Node agent, no DOM), register the smartglasses view
// so it renders inline in the terminal as the unified SmartglassesSpatialView.
// Lazy + DOM-guarded so the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view.tsx")
    .then((m) => m.registerSmartglassesTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
