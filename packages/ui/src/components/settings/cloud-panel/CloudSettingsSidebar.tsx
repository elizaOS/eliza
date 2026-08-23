/**
 * Sidebar for the cloud settings panel.
 *
 * Renders grouped section items with an account footer pinned to the bottom.
 * Uses Eliza design tokens for the macOS settings aesthetic.
 */
import { Check, ChevronUp, Circle, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { cn } from "../../../lib/utils";
import { useAppSelector } from "../../../state";
import { CLOUD_PANEL_GROUPS } from "./cloud-panel-groups";
import {
  type CloudPanelAccountFooterSection,
  type CloudPanelSection,
  cloudPanelAccountFooterSections,
  groupedCloudPanelSections,
} from "./cloud-panel-sections";

export type CloudAccountNavigationState =
  | "connected"
  | "disconnected"
  | "signing-out"
  | "sign-out-failed";

export interface CloudPanelNavigationOptions {
  replace?: boolean;
  showSection?: boolean;
}

export function CloudAccountMenu({
  accountState,
  activeSection,
  onSignOutAttemptFinish,
  onSignOutAttemptStart,
  onSelect,
}: {
  accountState: CloudAccountNavigationState;
  activeSection: string;
  onSignOutAttemptFinish: () => void;
  onSignOutAttemptStart: () => void;
  onSelect: (id: string, options?: CloudPanelNavigationOptions) => void;
}) {
  const handleInteractiveCloudLogin = useAppSelector(
    (s) => s.handleInteractiveCloudLogin,
  );
  const handleCloudSignOut = useAppSelector((s) => s.handleCloudSignOut);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const [open, setOpen] = useState(false);

  const startSignOut = () => {
    setOpen(false);
    // Account-only data is unmounted synchronously and remains unavailable
    // until the session is observably absent. A resolved disconnect can still
    // mean the backend-owned helper reported its failure through app state, so
    // every settled attempt is handed back to the panel for an explicit retry
    // decision rather than being treated as success optimistically.
    onSignOutAttemptStart();
    onSelect("general", { replace: true, showSection: false });
    void handleCloudSignOut()
      .catch(() => {
        // error-policy:J4 sign-out failure surfaces as a visible notice in
        // addition to the persistent inline retry affordance below.
        setActionNotice?.("Could not sign out of Eliza Cloud.", "error", 5000);
      })
      .finally(onSignOutAttemptFinish);
  };

  if (accountState === "disconnected") {
    return (
      <div className="border-t border-border px-3 py-3">
        <button
          type="button"
          className="keyboard-focus-surface flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-bg-hover"
          onClick={() => {
            void handleInteractiveCloudLogin().catch((error: unknown) => {
              // error-policy:J4 login failure surfaces as a visible notice.
              setActionNotice?.(
                error instanceof Error
                  ? error.message
                  : "Could not start Cloud login.",
                "error",
                5000,
              );
            });
          }}
        >
          <Circle className="h-2.5 w-2.5 text-muted-foreground" />
          Connect Cloud
        </button>
      </div>
    );
  }

  if (accountState === "signing-out") {
    return (
      <div className="border-t border-border px-3 py-3">
        <div
          aria-live="polite"
          className="flex min-h-9 items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
          />
          Signing out…
        </div>
      </div>
    );
  }

  if (accountState === "sign-out-failed") {
    return (
      <div className="space-y-2 border-t border-border px-3 py-3">
        <p className="px-2 text-xs text-destructive" role="alert">
          Cloud sign-out didn&apos;t finish.
        </p>
        <button
          type="button"
          className="keyboard-focus-surface flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-bg-hover"
          onClick={startSignOut}
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          Retry sign out
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-border px-3 py-2">
      <button
        type="button"
        aria-controls="cloud-account-menu"
        aria-expanded={open}
        className="keyboard-focus-surface flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-bg-hover"
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-2 truncate">
          <Circle className="h-2.5 w-2.5 shrink-0 text-ok" />
          <span className="truncate text-muted-foreground">Connected</span>
        </span>
        <ChevronUp
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            !open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div
          id="cloud-account-menu"
          className="mt-1 space-y-0.5 rounded-md border border-border bg-card p-1"
        >
          {cloudPanelAccountFooterSections().map((section) => (
            <FooterLink
              key={section.id}
              section={section}
              active={section.id === activeSection}
              onSelect={onSelect}
            />
          ))}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            className="keyboard-focus-surface flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
            onClick={startSignOut}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function FooterLink({
  section,
  active,
  onSelect,
}: {
  section: CloudPanelAccountFooterSection;
  active: boolean;
  onSelect: (id: string, options?: CloudPanelNavigationOptions) => void;
}) {
  return (
    <a
      href={`#${section.id}`}
      onClick={(event) => {
        event.preventDefault();
        onSelect(section.id);
      }}
      aria-current={active ? "page" : undefined}
      className={cn(
        "keyboard-focus-surface flex w-full items-center rounded-sm px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-accent-subtle font-medium text-foreground"
          : "text-muted-foreground hover:bg-bg-hover hover:text-foreground",
      )}
    >
      {section.footerLabel}
    </a>
  );
}

function SectionItem({
  section,
  active,
  onSelect,
}: {
  section: CloudPanelSection;
  active: boolean;
  onSelect: (id: string, options?: CloudPanelNavigationOptions) => void;
}) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(section.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "keyboard-focus-surface flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-accent-subtle font-medium text-foreground"
          : "text-muted-foreground hover:bg-bg-hover hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <span className="truncate">{section.label}</span>
      {active && (
        <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground" />
      )}
    </button>
  );
}

export function CloudSettingsSidebar({
  accountState,
  activeSection,
  onSignOutAttemptFinish,
  onSignOutAttemptStart,
  onSelect,
}: {
  accountState: CloudAccountNavigationState;
  activeSection: string;
  onSignOutAttemptFinish: () => void;
  onSignOutAttemptStart: () => void;
  onSelect: (id: string, options?: CloudPanelNavigationOptions) => void;
}) {
  const grouped = groupedCloudPanelSections();

  return (
    <nav
      aria-label="Settings sections"
      className="flex h-full w-60 shrink-0 flex-col bg-card pt-8"
    >
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {CLOUD_PANEL_GROUPS.map((group) => {
          const sections = grouped[group.id];
          if (!sections?.length) return null;
          return (
            <div key={group.id} className="mb-5 last:mb-0">
              <h2 className="mb-1.5 px-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </h2>
              <div className="space-y-0.5">
                {sections.map((section) => (
                  <SectionItem
                    key={section.id}
                    section={section}
                    active={section.id === activeSection}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <CloudAccountMenu
        accountState={accountState}
        activeSection={activeSection}
        onSignOutAttemptFinish={onSignOutAttemptFinish}
        onSignOutAttemptStart={onSignOutAttemptStart}
        onSelect={onSelect}
      />
    </nav>
  );
}
