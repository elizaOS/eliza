import { Button, SegmentedControl } from "@elizaos/ui";
import type React from "react";
import type { Tab } from "../../navigation";
import { useApp } from "../../state";
import { DesktopWorkspaceSection } from "../settings/DesktopWorkspaceSection";
import { FineTuningView } from "../training/injected";

type SubTab = "fine-tuning" | "desktop";

const SUB_TABS: Array<{
  id: SubTab;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    id: "fine-tuning",
    labelKey: "finetuningview.FineTuning",
    descriptionKey: "finetuningview.BuildDatasetsFrom",
  },
];

const MODAL_SUB_TABS = SUB_TABS;

function mapTabToSubTab(tab: Tab): SubTab {
  switch (tab) {
    case "fine-tuning":
      return "fine-tuning";
    case "desktop":
      return "desktop";
    default:
      return "fine-tuning";
  }
}

export function AdvancedPageView({ inModal }: { inModal?: boolean } = {}) {
  const { tab, setTab, t } = useApp();

  const currentSubTab = mapTabToSubTab(tab);
  const tabs = inModal ? MODAL_SUB_TABS : SUB_TABS;
  const handleSubTabChange = (subTab: SubTab) => {
    setTab(subTab as Tab);
  };
  const advancedSubTabItems = tabs.map((subTab) => ({
    value: subTab.id,
    label: t(subTab.labelKey),
    testId: `advanced-subtab-${subTab.id}`,
  }));
  const advancedContentHeader = inModal ? undefined : (
    <SegmentedControl
      value={currentSubTab}
      onValueChange={handleSubTabChange}
      items={advancedSubTabItems}
      buttonClassName="min-h-9 whitespace-nowrap px-3 py-2.5"
      data-testid="advanced-subtab-nav"
      aria-label={t("aria.advancedNavigation")}
    />
  );

  const renderSubTabButton = (
    subTab: { id: SubTab; labelKey: string; descriptionKey: string },
    options?: { compact?: boolean },
  ) => {
    const isActive = currentSubTab === subTab.id;
    const compact = options?.compact ?? false;
    const label = t(subTab.labelKey);
    const description = t(subTab.descriptionKey);

    return (
      <Button
        variant="ghost"
        key={subTab.id}
        aria-current={isActive ? "page" : undefined}
        className={`select-none [&_*]:select-none [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] focus:outline-none focus-visible:outline-none inline-flex select-none items-center rounded-xl border transition-all duration-150 ${
          compact ? "px-3 py-2.5" : "min-h-9 whitespace-nowrap px-2.5 py-1.5"
        } ${
          isActive
            ? "border-accent/26 bg-accent/14 text-txt-strong shadow-sm"
            : "border-transparent text-muted-strong hover:bg-card/60 hover:text-txt"
        }`}
        onClick={() => handleSubTabChange(subTab.id)}
        title={description}
        data-testid={`advanced-subtab-${subTab.id}`}
      >
        <div className="text-left">
          <div
            className={`text-sm ${
              isActive ? "font-semibold text-txt" : "font-medium"
            }`}
          >
            {label}
          </div>
        </div>
      </Button>
    );
  };

  const renderContent = () => {
    switch (currentSubTab) {
      case "fine-tuning":
        return <FineTuningView contentHeader={advancedContentHeader} />;
      case "desktop":
        return (
          <DesktopWorkspaceSection contentHeader={advancedContentHeader} />
        );
      default:
        return <FineTuningView contentHeader={advancedContentHeader} />;
    }
  };

  return (
    <div
      className={
        inModal
          ? "settings-modal-layout"
          : "flex w-full flex-col h-full min-h-0"
      }
    >
      {inModal ? (
        <nav className="settings-icon-sidebar">
          {tabs.map((subTab) => renderSubTabButton(subTab, { compact: true }))}
        </nav>
      ) : null}

      <div
        className={
          inModal
            ? "settings-content-area"
            : "flex w-full min-h-0 flex-1 flex-col"
        }
        style={
          inModal
            ? ({
                "--accent":
                  "var(--section-accent-advanced, var(--accent, #7b8fb5))",
                "--surface": "rgba(255, 255, 255, 0.06)",
                "--s-accent":
                  "var(--section-accent-advanced, var(--accent, #7b8fb5))",
                "--s-text-txt":
                  "var(--section-accent-advanced, var(--accent, #7b8fb5))",
                "--s-accent-glow":
                  "color-mix(in srgb, var(--section-accent-advanced, var(--accent, #7b8fb5)) 35%, transparent)",
                "--s-accent-subtle":
                  "color-mix(in srgb, var(--section-accent-advanced, var(--accent, #7b8fb5)) 12%, transparent)",
                "--s-grid-line":
                  "color-mix(in srgb, var(--section-accent-advanced, var(--accent, #7b8fb5)) 2%, transparent)",
                "--s-glow-edge":
                  "color-mix(in srgb, var(--section-accent-advanced, var(--accent, #7b8fb5)) 8%, transparent)",
              } as React.CSSProperties)
            : undefined
        }
      >
        {inModal ? (
          <div className="settings-section-pane pt-4">{renderContent()}</div>
        ) : (
          renderContent()
        )}
      </div>
    </div>
  );
}
