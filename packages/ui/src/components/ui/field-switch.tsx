/**
 * Controlled switch rendered as a labelled `<button role="switch">` — the toggle
 * affordance used inside settings fields, where the whole row (label + control)
 * is clickable.
 */
import * as React from "react";

import { Switch } from "./switch";

export interface FieldSwitchProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "checked" | "onChange" | "children"
  > {
  checked: boolean;
  label: React.ReactNode;
  onCheckedChange?: (checked: boolean) => void;
}

export const FieldSwitch = React.forwardRef<
  HTMLButtonElement,
  FieldSwitchProps
>(
  (
    { checked, className, disabled, label, onCheckedChange, onClick, ...props },
    ref,
  ) => (
    <Switch
      {...props}
      ref={ref}
      variant="field"
      checked={checked}
      disabled={disabled}
      onClick={onClick}
      onCheckedChange={onCheckedChange}
      className={className}
    >
      <span className="pointer-events-none text-left">{label}</span>
    </Switch>
  ),
);

FieldSwitch.displayName = "FieldSwitch";
