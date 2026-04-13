/** Glassmorphic pill-style tab switcher for onboarding panels. */
export function OnboardingTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="mx-auto mb-4 flex w-fit items-center gap-1 rounded-lg border border-[var(--onboarding-card-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01)),var(--onboarding-card-bg)] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_26px_rgba(0,0,0,0.14)] backdrop-blur-[14px]">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`relative rounded-md border-none px-5 py-2 text-xs font-semibold uppercase tracking-[0.14em] outline-none transition-all duration-300 ${
              isActive
                ? "bg-[var(--onboarding-accent-bg)] text-[var(--onboarding-text-strong)] shadow-[0_0_0_1px_rgba(240,185,11,0.14),0_0_12px_rgba(240,185,11,0.12)]"
                : "bg-transparent text-[var(--onboarding-text-subtle)] hover:text-[var(--onboarding-text-strong)] hover:bg-[var(--onboarding-card-bg-hover)]"
            }`}
            style={{ textShadow: "0 1px 5px rgba(3,5,10,0.34)" }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
