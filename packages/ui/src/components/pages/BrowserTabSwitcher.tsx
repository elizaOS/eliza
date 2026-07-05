/**
 * Safari/Arc-mobile-style folded tab switcher for the Browser view (#13596).
 *
 * The browser used to render every tab in a permanent, unbounded sidebar strip
 * — which breaks the single-column touch-first doctrine and overflows at 375px
 * once more than a handful of tabs are open. This module folds that strip: the
 * toolbar shows one compact count control ({@link BrowserTabFoldControl}) that
 * names the active tab and its total; tapping it opens a switcher overlay
 * ({@link BrowserTabSwitcher}) of stacked tab cards the user taps to switch or
 * closes with a per-card button. The active tab is always represented in the
 * control (never folded away), so switching back is one tap regardless of how
 * many tabs are open.
 *
 * The switcher is presentational: the owning `BrowserWorkspaceView` passes the
 * folded tab model ({@link foldBrowserTabs}) and the activate/close callbacks it
 * already drives through `runBrowserWorkspaceAction`. Agent-partition tabs run
 * in a separate session (`persist:eliza-browser-agent`) and stay visually
 * distinct here (their own section, an accent monogram) so a user never confuses
 * an agent-driven page for one of their own. Rendering inside a `role="dialog"`
 * keeps the overlay above the native `<electrobun-webview>` OOPIF, which masks
 * dialog rects (see `BROWSER_WORKSPACE_TAB_MASK_SELECTORS`).
 */
import { Globe, Plus, X } from "lucide-react";
import { useAgentElement } from "../../agent-surface";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

/** A tab as the switcher needs to render it — the view maps its richer
 *  `BrowserWorkspaceTab` down to this display shape so the switcher stays free
 *  of transport/session concerns. */
export interface BrowserSwitcherTab {
  id: string;
  /** Human label already resolved from title/URL by the view. */
  label: string;
  /** Secondary line (URL + provider/status), already composed by the view. */
  description: string;
  /** One-character monogram shown when the tab isn't the focused session. */
  monogram: string;
  /** Section the tab belongs to — drives grouping and agent distinction. */
  section: BrowserSwitcherSection;
  /** Internal (app-managed) tabs cannot be closed by the user. */
  closable: boolean;
  /** The tab currently holding the visible browser session (accent dot). */
  hasSessionFocus: boolean;
}

export type BrowserSwitcherSection = "user" | "agent" | "app";

/** A section of the folded switcher: its ordered tabs plus the labels the view
 *  localizes. Empty sections are dropped so the overlay never shows dead
 *  headers. */
export interface BrowserSwitcherSectionGroup {
  key: BrowserSwitcherSection;
  label: string;
  tabs: BrowserSwitcherTab[];
}

/** The folded model the control + overlay both read. `count` is the total tab
 *  count (all sections); `activeTab` is always present in `sections` too — the
 *  active tab is never folded out of reach. */
export interface FoldedBrowserTabs {
  sections: BrowserSwitcherSectionGroup[];
  count: number;
  activeTab: BrowserSwitcherTab | null;
}

/**
 * Fold a flat, section-tagged tab list into the switcher model. Sections render
 * user → agent → app (the user's own tabs first, the agent's session set next,
 * app-managed sessions last); empty sections are omitted. `activeTab` is
 * resolved from `activeTabId` against the same list so the control and overlay
 * agree on which card is current. Pure and deterministic — unit-tested directly.
 */
export function foldBrowserTabs(
  tabs: BrowserSwitcherTab[],
  activeTabId: string | null,
  labels: Record<BrowserSwitcherSection, string>,
): FoldedBrowserTabs {
  const order: BrowserSwitcherSection[] = ["user", "agent", "app"];
  const sections = order
    .map((key) => ({
      key,
      label: labels[key],
      tabs: tabs.filter((tab) => tab.section === key),
    }))
    .filter((group) => group.tabs.length > 0);

  return {
    sections,
    count: tabs.length,
    activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
  };
}

/**
 * The compact fold affordance in the toolbar: a single pill naming the active
 * tab and the total count. Opening it is the only path to the rest of the tabs,
 * so it stays a full-height (`min-h-11`, ≥44px) touch target and is always
 * present even with one tab (the user still reads which tab is live).
 */
export function BrowserTabFoldControl({
  activeLabel,
  count,
  onOpen,
  disabled,
  openLabel,
}: {
  activeLabel: string;
  count: number;
  onOpen: () => void;
  disabled?: boolean;
  /** Accessible + agent label, e.g. "Show 4 tabs". */
  openLabel: string;
}): React.JSX.Element {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "tab-switcher",
    role: "button",
    label: openLabel,
    group: "browser-nav",
    description: "Open the browser tab switcher",
    onActivate: onOpen,
  });
  return (
    <Button
      ref={ref}
      {...agentProps}
      type="button"
      variant="outline"
      onClick={onOpen}
      disabled={disabled}
      aria-label={openLabel}
      aria-haspopup="dialog"
      data-testid="browser-workspace-tab-fold-control"
      className="flex h-11 min-h-11 min-w-0 shrink-0 items-center gap-2 rounded-full border-border/40 bg-card/70 px-3 text-sm text-txt"
    >
      <Globe className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 max-w-[9rem] truncate font-medium">
        {activeLabel}
      </span>
      <span
        className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-bg-muted px-1.5 text-2xs font-semibold tabular-nums text-muted"
        data-testid="browser-workspace-tab-count"
        aria-hidden
      >
        {count}
      </span>
    </Button>
  );
}

/**
 * One tab card in the switcher grid: tap the body to switch, tap the corner ×
 * to close (internal tabs render no close affordance). Agent-session tabs carry
 * an accent-tinted monogram so they read as distinct from the user's own tabs.
 * Both the switch and close targets are ≥44px touch surfaces.
 */
function BrowserTabCard({
  tab,
  active,
  section,
  closeLabel,
  agentActiveLabel,
  onActivate,
  onClose,
}: {
  tab: BrowserSwitcherTab;
  active: boolean;
  section: BrowserSwitcherSection;
  closeLabel: string;
  agentActiveLabel: string;
  onActivate: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { ref: activateRef, agentProps: activateAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `switcher-tab-${tab.id}`,
      role: "tab",
      label: tab.label,
      group: "browser-tabs",
      description: `Activate browser tab: ${tab.label}`,
      status: active ? "active" : "inactive",
      onActivate,
    });
  const { ref: closeRef, agentProps: closeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `switcher-tab-close-${tab.id}`,
      role: "button",
      label: `${closeLabel} ${tab.label}`,
      group: "browser-tabs",
      description: `Close browser tab: ${tab.label}`,
      onActivate: onClose,
    });
  const isAgent = section === "agent";
  return (
    <div className="group relative" data-testid={`browser-tab-card-${tab.id}`}>
      <Button
        ref={activateRef}
        {...activateAgentProps}
        role="tab"
        aria-selected={active}
        aria-current={active ? "page" : undefined}
        title={tab.description}
        onClick={onActivate}
        variant="ghost"
        className={`flex h-auto min-h-11 w-full min-w-0 flex-col items-start justify-start gap-1 whitespace-normal rounded-sm border p-3 text-left font-normal transition-colors ${
          tab.closable ? "pr-10" : "pr-3"
        } ${
          active
            ? "border-accent/60 bg-bg-muted/50 text-txt"
            : "border-border/40 text-txt hover:bg-bg-muted/50"
        }`}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
              isAgent ? "bg-accent/15 text-accent" : "bg-bg-muted text-muted"
            }`}
          >
            {tab.hasSessionFocus ? (
              <>
                <span aria-hidden className="h-2 w-2 rounded-full bg-accent" />
                <span className="sr-only">{agentActiveLabel}</span>
              </>
            ) : (
              tab.monogram
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium leading-snug">
            {tab.label}
          </span>
        </span>
        <span className="block w-full truncate text-2xs leading-snug text-muted/70">
          {tab.description}
        </span>
      </Button>
      {tab.closable ? (
        <Button
          ref={closeRef}
          {...closeAgentProps}
          type="button"
          aria-label={`${closeLabel} ${tab.label}`}
          title={`${closeLabel}: ${tab.label}`}
          variant="ghost"
          size="icon"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
          data-testid={`browser-tab-card-close-${tab.id}`}
          className="absolute right-1 top-1 h-9 w-9 rounded-sm text-muted transition-colors hover:bg-bg-muted/60 hover:text-danger"
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The switcher overlay: a stacked, single-column grid of every tab card grouped
 * by section, plus a "new tab" affordance. Controlled by the view (`open` /
 * `onOpenChange`); switching a tab also closes the overlay so the picked page is
 * immediately usable. Rendered in a `Dialog` (masked over the native OOPIF) with
 * the shared bottom-sheet-on-mobile / centered-on-desktop geometry and safe-area
 * insets the primitive already applies.
 */
export function BrowserTabSwitcher({
  open,
  onOpenChange,
  folded,
  activeTabId,
  title,
  closeLabel,
  agentActiveLabel,
  newTabLabel,
  emptyLabel,
  onActivateTab,
  onCloseTab,
  onNewTab,
  actionsDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folded: FoldedBrowserTabs;
  activeTabId: string | null;
  title: string;
  closeLabel: string;
  agentActiveLabel: string;
  newTabLabel: string;
  emptyLabel: string;
  onActivateTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  actionsDisabled?: boolean;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        data-testid="browser-workspace-tab-switcher"
        className="gap-3"
      >
        <DialogHeader className="flex-row items-center justify-between gap-2 pr-8 text-left">
          <DialogTitle>{title}</DialogTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 min-h-9 shrink-0 gap-1.5 rounded-full px-3"
            disabled={actionsDisabled}
            onClick={() => {
              onNewTab();
              onOpenChange(false);
            }}
            data-testid="browser-workspace-tab-switcher-new-tab"
            aria-label={newTabLabel}
          >
            <Plus className="h-4 w-4" aria-hidden />
            <span className="truncate">{newTabLabel}</span>
          </Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {folded.count === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted">
              {emptyLabel}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {folded.sections.map((group) => (
                <section key={group.key} aria-label={group.label}>
                  <h3 className="px-1 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted/70">
                    {group.label}
                  </h3>
                  <div
                    role="tablist"
                    aria-label={group.label}
                    className="grid grid-cols-1 gap-2"
                  >
                    {group.tabs.map((tab) => (
                      <BrowserTabCard
                        key={tab.id}
                        tab={tab}
                        active={tab.id === activeTabId}
                        section={group.key}
                        closeLabel={closeLabel}
                        agentActiveLabel={agentActiveLabel}
                        onActivate={() => {
                          onActivateTab(tab.id);
                          onOpenChange(false);
                        }}
                        onClose={() => onCloseTab(tab.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
