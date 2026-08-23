/**
 * Real-browser fixture for the two drag-to-resize handles that have no
 * web-reachable live mount in the ui-smoke stack (#10722 item 5):
 *
 *   1. `Sidebar` (`sidebar-root.tsx`, `data-testid="sidebar-resize-handle"`)
 *      — live mount is `ConversationsSidebar` inside the Electrobun
 *      `DetachedShellRoot`, never the web shell.
 *   2. Cloud `ResizablePanelGroup`/`ResizableHandle`
 *      (`cloud-ui/components/resizable.tsx`).
 *
 * The COMPONENTS are the real shipped ones; only this mounting page is
 * synthetic (the isolated `__e2e__` esbuild-fixture pattern used by the chat
 * sheet / home screen runners). The e2e drives the handles with genuine
 * staged pointer input in headless Chromium.
 */

import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../../cloud-ui/components/resizable";
import { Sidebar } from "../sidebar/sidebar-root";

function SidebarSection() {
  const [width, setWidth] = useState(280);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section
      data-testid="sidebar-section"
      style={{ position: "relative", height: 360, width: 640 }}
    >
      <Sidebar
        testId="fixture-sidebar"
        variant="default"
        collapsible
        resizable
        width={width}
        minWidth={200}
        maxWidth={480}
        onWidthChange={(next) => {
          setWidth(next);
          console.log(`[fixture] sidebar width -> ${Math.round(next)}`);
        }}
        onCollapseRequest={() => {
          setCollapsed(true);
          console.log("[fixture] sidebar collapse requested");
        }}
        collapsed={collapsed}
        onCollapsedChange={(next) => {
          setCollapsed(next);
          console.log(`[fixture] sidebar collapsed -> ${next}`);
        }}
        expandButtonTestId="fixture-sidebar-expand"
      >
        <div style={{ padding: 12 }}>sidebar body</div>
      </Sidebar>
    </section>
  );
}

function CloudResizableSection() {
  return (
    <section
      data-testid="cloud-resizable-section"
      style={{ height: 240, width: 600 }}
    >
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel
          defaultSize={50}
          minSize={15}
          maxSize={85}
          data-testid="cloud-panel-left"
        >
          <div style={{ padding: 8 }}>left panel</div>
        </ResizablePanel>
        <ResizableHandle withHandle data-testid="cloud-resize-handle" />
        <ResizablePanel
          defaultSize={50}
          minSize={15}
          maxSize={85}
          data-testid="cloud-panel-right"
        >
          <div style={{ padding: 8 }}>right panel</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}

function Fixture() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 24,
        padding: 16,
      }}
    >
      <SidebarSection />
      <CloudResizableSection />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture: #root missing");
createRoot(rootEl).render(<Fixture />);
