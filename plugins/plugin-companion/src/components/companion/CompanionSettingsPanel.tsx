import { CompanionPerformanceSettings } from "./CompanionPerformanceSettings";

export function CompanionSettingsPanel() {
  return (
    <div
      data-testid="companion-settings-panel"
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex justify-center px-1.5 sm:px-4"
      style={{
        paddingBottom: "calc(var(--safe-area-bottom, 0px) + 0.75rem)",
      }}
    >
      <div className="w-full max-w-lg px-3 py-3 sm:px-4">
        <CompanionPerformanceSettings />
      </div>
    </div>
  );
}
