import {
  Button,
  type CompanionHalfFramerateMode,
  type CompanionVrmPowerMode,
  Switch,
  useApp,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  COMPANION_HALF_FRAMERATE_OPTIONS,
  COMPANION_VRM_POWER_OPTIONS,
} from "../../types/render-modes";

export function CompanionPerformanceSettings() {
  const {
    companionVrmPowerMode,
    setCompanionVrmPowerMode,
    companionHalfFramerateMode,
    setCompanionHalfFramerateMode,
    companionAnimateWhenHidden,
    setCompanionAnimateWhenHidden,
    t,
  } = useApp();

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
        {t("settings.appearance.companionPerformance", {
          defaultValue: "Companion performance",
        })}
      </h3>
      <div
        className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-3 py-3"
        data-testid="settings-companion-vrm-power"
      >
        <div className="min-w-0">
          <div className="text-xs font-semibold text-txt">
            {t("settings.companionVrmPower.label", {
              defaultValue: "Companion rendering",
            })}
          </div>
          <div className="mt-1 text-2xs leading-snug text-muted">
            {t("settings.companionVrmPower.desc", {
              defaultValue:
                "Control how much GPU the 3D companion uses while rendering.",
            })}
          </div>
        </div>
        <SegmentedSetting>
          {COMPANION_VRM_POWER_OPTIONS.map((mode: CompanionVrmPowerMode) => (
            <CompanionPerfModeButton
              key={mode}
              agentId={`settings-vrm-power-${mode}`}
              group="companion-vrm-power"
              label={t(`settings.companionVrmPower.${mode}`)}
              testId={`settings-companion-vrm-power-${mode}`}
              active={companionVrmPowerMode === mode}
              onSelect={() => setCompanionVrmPowerMode(mode)}
            />
          ))}
        </SegmentedSetting>
        <div
          className="flex flex-col gap-2 border-t border-border pt-3"
          data-testid="settings-companion-half-framerate"
        >
          <div className="min-w-0">
            <div className="text-xs font-semibold text-txt">
              {t("settings.companionHalfFramerate.label", {
                defaultValue: "Companion frame rate",
              })}
            </div>
            <div className="mt-1 text-2xs leading-snug text-muted">
              {t("settings.companionHalfFramerate.desc", {
                defaultValue:
                  "Optionally cap the 3D companion at about half display refresh rate.",
              })}
            </div>
          </div>
          <SegmentedSetting>
            {COMPANION_HALF_FRAMERATE_OPTIONS.map(
              (mode: CompanionHalfFramerateMode) => (
                <CompanionPerfModeButton
                  key={mode}
                  agentId={`settings-half-framerate-${mode}`}
                  group="companion-half-framerate"
                  label={t(`settings.companionHalfFramerate.${mode}`)}
                  testId={`settings-companion-half-framerate-${mode}`}
                  active={companionHalfFramerateMode === mode}
                  onSelect={() => setCompanionHalfFramerateMode(mode)}
                />
              ),
            )}
          </SegmentedSetting>
        </div>
        <div
          className="flex flex-col gap-2 border-t border-border pt-3"
          data-testid="settings-companion-animate-when-hidden"
        >
          <div className="text-xs font-semibold text-txt">
            {t("settings.companionAnimateWhenHidden.title", {
              defaultValue: "Animate in background",
            })}
          </div>
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0 flex-1 pr-2 text-2xs leading-snug text-muted">
              {t("settings.companionAnimateWhenHidden.desc", {
                defaultValue:
                  "Keep the avatar idling while the window or tab is hidden.",
              })}
            </div>
            <CompanionAnimateWhenHiddenToggle
              checked={companionAnimateWhenHidden}
              onCheckedChange={setCompanionAnimateWhenHidden}
              label={t("settings.companionAnimateWhenHidden.title", {
                defaultValue: "Animate in background",
              })}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function SegmentedSetting({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

function CompanionPerfModeButton({
  agentId,
  group,
  label,
  testId,
  active,
  onSelect,
}: {
  agentId: string;
  group: string;
  label: string;
  testId: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "tab",
    label,
    group,
    status: active ? "active" : "inactive",
    description: `Set companion rendering to ${label}`,
  });
  return (
    <Button
      ref={ref}
      type="button"
      variant={active ? "default" : "ghost"}
      size="sm"
      className="min-h-touch flex-1 basis-[calc(50%-0.25rem)] rounded-lg border px-2 py-1.5 text-xs-tight font-semibold !whitespace-normal sm:basis-0"
      onClick={onSelect}
      aria-pressed={active}
      aria-current={active ? "true" : undefined}
      data-testid={testId}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function CompanionAnimateWhenHiddenToggle({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "settings-animate-when-hidden",
    role: "toggle",
    label,
    group: "companion-performance",
    status: checked ? "active" : "inactive",
    description: "Keep the avatar animating while the window is hidden",
    onActivate: () => onCheckedChange(!checked),
  });
  return (
    <Switch
      ref={ref}
      className="shrink-0"
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      data-testid="settings-companion-animate-when-hidden-toggle"
      {...agentProps}
    />
  );
}
