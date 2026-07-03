import { Children, isValidElement, type ReactNode } from "react";
import {
  TabsContent,
  TabsList,
  TabsTrigger,
  Tabs as UiTabs,
} from "../../../components/ui/tabs";

export type CalloutType = "info" | "warning" | "error" | "default";

export function Callout({
  type = "default",
  emoji,
  children,
}: {
  type?: CalloutType;
  emoji?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`docs-callout docs-callout-${type}`}>
      {emoji ? <span className="docs-callout-emoji">{emoji}</span> : null}
      <div className="docs-callout-body">{children}</div>
    </div>
  );
}

function CardsCard({
  title,
  href,
  icon,
  children,
}: {
  title: string;
  href: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const isExternal = /^https?:\/\//.test(href);
  return (
    <a
      href={href}
      className="docs-card"
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
    >
      {icon ? <div className="docs-card-icon">{icon}</div> : null}
      <div className="docs-card-title">{title}</div>
      {children ? <div className="docs-card-desc">{children}</div> : null}
    </a>
  );
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="docs-cards-grid">{children}</div>;
}
Cards.Card = CardsCard;

export function Steps({ children }: { children: ReactNode }) {
  return <div className="docs-steps">{children}</div>;
}

function TabsTab({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Tabs({
  items,
  children,
}: {
  items: ReactNode[];
  children: ReactNode;
}) {
  const panels = Children.toArray(children).filter(isValidElement);
  const tabs = items.map((label, index) => ({
    label,
    panel: panels[index] ?? null,
    value: `tab-${index}`,
  }));
  const defaultValue = tabs[0]?.value;

  if (!defaultValue) {
    return <div className="docs-tabs" />;
  }

  return (
    <UiTabs
      defaultValue={defaultValue}
      className="docs-tabs flex flex-col gap-3"
    >
      <TabsList className="docs-tabs-list h-auto flex-wrap justify-start gap-2 bg-transparent p-0">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="docs-tab-trigger h-auto rounded-sm border border-border px-3 py-1 text-sm data-[state=active]:bg-bg data-[state=active]:text-txt"
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent
          key={tab.value}
          value={tab.value}
          className="docs-tabs-content mt-0"
        >
          {tab.panel}
        </TabsContent>
      ))}
    </UiTabs>
  );
}
Tabs.Tab = TabsTab;
