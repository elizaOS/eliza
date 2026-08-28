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
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Separator } from "../../ui/separator";
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
      <Card asChild variant="topDivider" padding="default">
        <div>
          <Button
            type="button"
            variant="ghost"
            size="row"
            align="start"
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
            <Circle className="size-2.5 text-muted-foreground" />
            Connect Cloud
          </Button>
        </div>
      </Card>
    );
  }

  if (accountState === "signing-out") {
    return (
      <Card asChild variant="topDivider" padding="default">
        <div>
          <div
            aria-live="polite"
            className="flex min-h-9 items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2
              aria-hidden="true"
              className="size-3.5 animate-spin motion-reduce:animate-none"
            />
            Signing out…
          </div>
        </div>
      </Card>
    );
  }

  if (accountState === "sign-out-failed") {
    return (
      <Card asChild variant="topDivider" stack="compact" padding="default">
        <div>
          <p className="px-2 text-xs text-destructive" role="alert">
            Cloud sign-out didn&apos;t finish.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="row"
            align="start"
            onClick={startSignOut}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Retry sign out
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card asChild variant="topDivider" padding="compact">
      <div>
        <Button
          type="button"
          aria-controls="cloud-account-menu"
          aria-expanded={open}
          variant="ghost"
          size="row"
          className="justify-between"
          onClick={() => setOpen(!open)}
        >
          <span className="flex items-center gap-2 truncate">
            <Circle className="size-2.5 shrink-0 text-ok" />
            <span className="truncate text-muted-foreground">Connected</span>
          </span>
          <ChevronUp
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              !open && "rotate-180",
            )}
          />
        </Button>
        {open && (
          <Card
            id="cloud-account-menu"
            variant="insetCompact"
            className="mt-1 space-y-0.5 p-2"
          >
            {cloudPanelAccountFooterSections().map((section) => (
              <FooterLink
                key={section.id}
                section={section}
                active={section.id === activeSection}
                onSelect={onSelect}
              />
            ))}
            <Separator className="my-1" />
            <Button
              type="button"
              variant="surfaceDestructive"
              size="row"
              align="start"
              onClick={startSignOut}
            >
              Sign out
            </Button>
          </Card>
        )}
      </div>
    </Card>
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
    <Button
      asChild
      variant="selection"
      size="content"
      data-state={active ? "on" : "off"}
      className={cn(
        "keyboard-focus-surface flex w-full items-center px-2 py-1.5 text-sm",
        active && "font-medium",
      )}
    >
      <a
        href={`#${section.id}`}
        onClick={(event) => {
          event.preventDefault();
          onSelect(section.id);
        }}
        aria-current={active ? "page" : undefined}
      >
        {section.footerLabel}
      </a>
    </Button>
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
    <Button
      variant="selection"
      size="compact"
      align="start"
      data-state={active ? "on" : "off"}
      type="button"
      onClick={() => onSelect(section.id)}
      aria-current={active ? "page" : undefined}
      className="keyboard-focus-surface w-full"
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <span className="truncate">{section.label}</span>
      {active && (
        <Check className="ml-auto size-3.5 shrink-0 text-foreground" />
      )}
    </Button>
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
