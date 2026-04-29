import { Menu, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import { LifeOpsNavRail } from "./LifeOpsNavRail.js";
import { LifeOpsResizableSidebar } from "./LifeOpsResizableSidebar.js";

interface LifeOpsWorkspaceShellProps {
  compactLayout: boolean;
  section: LifeOpsSection;
  navigate: (section: LifeOpsSection) => void;
  children: ReactNode;
}

const MOBILE_TOP_BAR_HEIGHT = "2.375rem";
const MOBILE_BOTTOM_CLEARANCE = "calc(3.625rem + var(--safe-area-bottom, 0px))";

export function LifeOpsWorkspaceShell({
  compactLayout,
  section,
  navigate,
  children,
}: LifeOpsWorkspaceShellProps) {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const previousSectionRef = useRef(section);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!compactLayout || typeof window === "undefined") {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      let node: HTMLElement | null = workspaceRef.current;
      while (node) {
        if (node.scrollWidth > node.clientWidth + 1) {
          node.scrollLeft = 0;
        }
        node = node.parentElement;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [compactLayout]);

  useEffect(() => {
    if (!compactLayout) {
      setMobileNavOpen(false);
    }
  }, [compactLayout]);

  useEffect(() => {
    if (previousSectionRef.current !== section) {
      previousSectionRef.current = section;
      setMobileNavOpen(false);
    }
  }, [section]);

  const handleNavigate = (next: LifeOpsSection) => {
    navigate(next);
    if (compactLayout) {
      setMobileNavOpen(false);
    }
  };

  return (
    <div ref={workspaceRef} className="flex h-full min-h-0 min-w-0">
      {compactLayout ? null : (
        <LifeOpsResizableSidebar
          storageKey="lifeops:nav-rail-width"
          defaultWidth={296}
          minWidth={220}
          maxWidth={420}
          side="right"
          testId="lifeops-nav-rail-resizable"
          className="border-r border-border/12"
        >
          <LifeOpsNavRail activeSection={section} onNavigate={handleNavigate} />
        </LifeOpsResizableSidebar>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {compactLayout ? (
          <div className="relative flex h-[2.375rem] shrink-0 items-center border-b border-border/12 bg-bg/90 px-2 backdrop-blur sm:px-3">
            <button
              type="button"
              data-testid="lifeops-workspace-nav-toggle"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-muted/50 hover:text-txt"
              aria-label={
                mobileNavOpen ? "Close LifeOps sidebar" : "Open LifeOps sidebar"
              }
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen((current) => !current)}
            >
              {mobileNavOpen ? (
                <X className="h-4 w-4" aria-hidden />
              ) : (
                <Menu className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>
        ) : null}

        {compactLayout && mobileNavOpen ? (
          <>
            <button
              type="button"
              data-testid="lifeops-mobile-nav-backdrop"
              className="fixed inset-x-0 z-30 bg-bg/65 backdrop-blur-[2px]"
              style={{
                top: `calc(var(--safe-area-top, 0px) + ${MOBILE_TOP_BAR_HEIGHT})`,
                bottom: MOBILE_BOTTOM_CLEARANCE,
              }}
              aria-label="Close LifeOps sidebar"
              onClick={() => setMobileNavOpen(false)}
            />
            <aside
              data-testid="lifeops-mobile-nav-drawer"
              className="fixed left-0 z-40 flex w-[min(19rem,92vw)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden border-r border-border/16 bg-bg shadow-2xl"
              style={{
                top: `calc(var(--safe-area-top, 0px) + ${MOBILE_TOP_BAR_HEIGHT})`,
                bottom: MOBILE_BOTTOM_CLEARANCE,
              }}
            >
              <div className="min-h-0 flex-1 overflow-hidden px-2 py-3">
                <LifeOpsNavRail
                  activeSection={section}
                  onNavigate={handleNavigate}
                  collapsible={false}
                />
              </div>
            </aside>
          </>
        ) : null}

        <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pb-6 pt-4 sm:px-6 sm:pb-8 sm:pt-5 lg:px-8 lg:pt-6">
          {children}
        </div>
      </div>
    </div>
  );
}
