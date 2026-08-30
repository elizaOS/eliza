/**
 * Tiny control-panel primitives for the Design Lab (segmented pickers, toggles,
 * action buttons, grouped rows). Deliberately dependency-free inline components
 * styled by lab.css — the lab's own chrome must never pull in the app design
 * system it is used to preview, so a token change in @elizaos/ui can't silently
 * restyle the harness around it.
 */
import type { ReactNode } from "react";
import { Button } from "../../../src/components/ui/button";
import { SegmentedControl } from "../../../src/components/ui/segmented-control";
import { Switch } from "../../../src/components/ui/switch";

export function ControlGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="lab-group">
      <div className="lab-group-label">{label}</div>
      <div className="lab-group-body">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <SegmentedControl
      className="lab-segmented"
      value={value}
      items={options.map((option) => ({
        ...option,
        testId: `lab-segment-${option.value}`,
      }))}
      onValueChange={onChange}
      buttonClassName="lab-seg"
      activeButtonClassName="is-active"
    />
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="lab-toggle">
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
      <span className="lab-toggle-track" aria-hidden />
      <span className="lab-toggle-label">{label}</span>
    </div>
  );
}

export function ActionButton({
  children,
  onClick,
  variant = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "default" | "primary";
}) {
  return (
    <Button
      variant="ghost"
      className={`lab-action ${variant === "primary" ? "is-primary" : ""}`}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="lab-row">{children}</div>;
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="lab-hint">{children}</p>;
}
