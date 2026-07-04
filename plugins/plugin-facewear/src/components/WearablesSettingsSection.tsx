/**
 * Wearables settings section hosts the facewear and smartglasses management
 * panels under the app settings surface.
 */
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@elizaos/ui/components/ui/tabs";
import { lazy, Suspense, useEffect, useState } from "react";

type WearablesTab = "facewear" | "smartglasses";

// Keep XR and BLE view code out of the host shell until Settings opens.
const FacewearView = lazy(() =>
  import("./FacewearView").then((m) => ({ default: m.FacewearView })),
);
const SmartglassesView = lazy(() =>
  import("../ui/SmartglassesView").then((m) => ({
    default: m.SmartglassesView,
  })),
);

function SectionFallback() {
  return (
    <div className="p-6 text-sm text-muted-foreground">Loading wearables…</div>
  );
}

/**
 * Combined "Wearables" Settings sub-view.
 *
 * Hosts the facewear (XR headset) device manager and the Even Realities
 * smartglasses dashboard as two tabs. This replaces the former standalone
 * `/apps/facewear` and `/apps/smartglasses` launcher views — wearable hardware
 * is configuration, so it lives under Settings. The agent's XR/TUI surfaces and
 * `FACEWEAR_*`/`SMARTGLASSES_*`/`XR_*` actions are unchanged.
 */
export function WearablesSettingsSection() {
  const [tab, setTab] = useState<WearablesTab>("facewear");

  // The facewear "Manage" control asks to jump to the smartglasses sibling tab
  // (it used to navigate to the now-removed /apps/smartglasses route).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail === "facewear" || detail === "smartglasses") setTab(detail);
    };
    window.addEventListener("wearables:select-tab", handler);
    return () => window.removeEventListener("wearables:select-tab", handler);
  }, []);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as WearablesTab)}
      className="flex h-full flex-col gap-4"
    >
      <TabsList className="self-start">
        <TabsTrigger value="facewear">Headsets &amp; XR</TabsTrigger>
        <TabsTrigger value="smartglasses">Smartglasses</TabsTrigger>
      </TabsList>
      <TabsContent value="facewear" className="flex-1 overflow-auto">
        <Suspense fallback={<SectionFallback />}>
          <FacewearView />
        </Suspense>
      </TabsContent>
      <TabsContent value="smartglasses" className="flex-1 overflow-auto">
        <Suspense fallback={<SectionFallback />}>
          <SmartglassesView />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}
