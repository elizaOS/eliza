/**
 * Sidebar for the cloud settings panel.
 *
 * Renders grouped section items with an account footer pinned to the bottom.
 * Uses NuPhy UI design tokens for the macOS settings aesthetic.
 */
import { Check, ChevronUp, Circle } from "lucide-react";
import { useState } from "react";
import { useAppSelector } from "../../../state";
import { cn } from "../../../lib/utils";
import {
  CLOUD_PANEL_GROUPS,
} from "./cloud-panel-groups";
import {
  type CloudPanelSection,
  groupedCloudPanelSections,
} from "./cloud-panel-sections";

function CloudAccountFooter() {
  const elizaCloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const [open, setOpen] = useState(false);

  if (!elizaCloudConnected) {
    return (
      <div className="border-t border-[var(--hairline)] px-3 py-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--fill)]"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("eliza:cloud-login-requested"),
            );
          }}
        >
          <Circle className="h-2.5 w-2.5 text-[var(--muted-foreground)]" />
          Connect Cloud
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--hairline)] px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[var(--fill)]"
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-2 truncate">
          <Circle className="h-2.5 w-2.5 shrink-0 text-[var(--success)]" />
          <span className="truncate text-[var(--muted-foreground)]">Connected</span>
        </span>
        <ChevronUp
          className={cn(
            "h-4 w-4 shrink-0 text-[var(--muted-foreground)] transition-transform",
            !open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 rounded-md border border-[var(--hairline)] bg-[var(--surface)] p-1">
          <FooterLink label="Manage billing" href="billing" />
          <FooterLink label="API keys" href="api-keys" />
          <FooterLink label="Sessions & privacy" href="security" />
          <FooterLink label="Organization" href="organization" />
          <div className="my-1 border-t border-[var(--hairline)]" />
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("eliza:cloud-sign-out-requested"),
              );
              setOpen(false);
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function FooterLink({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={`#cloud-${href}`}
      className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--foreground)]"
    >
      {label}
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
  onSelect: (id: string) => void;
}) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(section.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-[var(--accent)] font-medium text-[var(--foreground)]"
          : "text-[var(--muted-foreground)] hover:bg-[var(--fill)] hover:text-[var(--foreground)]",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          active
            ? "text-[var(--foreground)]"
            : "text-[var(--muted-foreground)]",
        )}
      />
      <span className="truncate">{section.label}</span>
      {active && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--foreground)]" />}
    </button>
  );
}

export function CloudSettingsSidebar({
  activeSection,
  onSelect,
}: {
  activeSection: string;
  onSelect: (id: string) => void;
}) {
  const grouped = groupedCloudPanelSections();

  return (
    <nav
      aria-label="Settings sections"
      className="flex h-full w-60 shrink-0 flex-col bg-[var(--surface)] pt-8"
    >
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {CLOUD_PANEL_GROUPS.map((group) => {
          const sections = grouped[group.id];
          if (!sections?.length) return null;
          return (
            <div key={group.id} className="mb-5 last:mb-0">
              <h2 className="mb-1.5 px-2.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
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
      <CloudAccountFooter />
    </nav>
  );
}
