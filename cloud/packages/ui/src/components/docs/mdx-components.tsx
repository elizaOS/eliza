import { Children, isValidElement, type ReactNode, useState } from "react";

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
  const [active, setActive] = useState(0);
  const panels = Children.toArray(children).filter(isValidElement);
  return (
    <div className="docs-tabs">
      <div className="docs-tabs-list" role="tablist">
        {items.map((label, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={`docs-tab-trigger${i === active ? " active" : ""}`}
            onClick={() => setActive(i)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="docs-tabs-content">{panels[active] ?? null}</div>
    </div>
  );
}
Tabs.Tab = TabsTab;
