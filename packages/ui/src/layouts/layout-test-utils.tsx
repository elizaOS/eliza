import type { SidebarProps } from "../components/composites/sidebar";

export function installMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({
      matches,
      media: "(min-width: 768px)",
      onchange: null,
      addEventListener: (
        _: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.add(listener);
      },
      removeEventListener: (
        _: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true,
    }),
  });

  return listeners;
}

export function enableTestRenderer() {
  (globalThis as Record<string, unknown>).__TEST_RENDERER__ = true;
}

export function disableTestRenderer() {
  delete (globalThis as Record<string, unknown>).__TEST_RENDERER__;
}

export function SidebarProbe({
  collapsible,
  mobileTitle,
  onMobileClose,
  testId = "sidebar-probe",
  variant,
}: SidebarProps) {
  return (
    <aside data-testid={testId}>
      <div>{`variant:${variant ?? "unset"}`}</div>
      <div>{`collapsible:${String(collapsible)}`}</div>
      <div>{mobileTitle ?? "Browse"}</div>
      {onMobileClose ? (
        <button type="button" onClick={onMobileClose}>
          Close sidebar
        </button>
      ) : null}
    </aside>
  );
}
