"use client";

type Tab = "overview" | "achievements" | "challenges";

interface TabNavigationProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

export function TabNavigation({ activeTab, onTabChange }: TabNavigationProps) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "challenges", label: "Challenges" },
    { id: "achievements", label: "Achievements" },
  ];

  return (
    <div className="flex border-border border-b">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`relative flex-1 py-3 text-center font-medium text-sm transition-colors ${
            activeTab === tab.id
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
          {activeTab === tab.id && (
            <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
          )}
        </button>
      ))}
    </div>
  );
}
