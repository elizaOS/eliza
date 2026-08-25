/**
 * SelectableTile owns the shared presentation and pressed-button semantics for
 * compact settings choices with a decorative visual and visible label.
 */

import { Check } from "lucide-react";
import * as React from "react";
import { cn } from "../../../lib/utils";
import { Button, type ButtonProps } from "../../ui/button";

export type SelectableTileLayout = "horizontal" | "vertical";

export interface SelectableTileProps
  extends Omit<
    ButtonProps,
    | "align"
    | "aria-pressed"
    | "asChild"
    | "children"
    | "className"
    | "data-state"
    | "onClick"
    | "shape"
    | "size"
    | "style"
    | "unstyled"
    | "variant"
  > {
  selected: boolean;
  label: string;
  leading: React.ReactNode;
  layout?: SelectableTileLayout;
  onSelect: () => void;
}

const CONTENT_LAYOUT: Record<SelectableTileLayout, string> = {
  horizontal: "flex-row",
  vertical: "flex-col",
};

export const SelectableTile = React.forwardRef<
  HTMLButtonElement,
  SelectableTileProps
>(
  (
    { selected, label, leading, layout = "vertical", onSelect, ...props },
    ref,
  ) => (
    <Button
      {...props}
      ref={ref}
      variant="selection"
      size="card"
      className="relative"
      aria-pressed={selected}
      data-state={selected ? "on" : "off"}
      onClick={onSelect}
    >
      <span
        data-slot="selectable-tile-content"
        data-layout={layout}
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center gap-2 text-center",
          CONTENT_LAYOUT[layout],
        )}
      >
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center justify-center"
        >
          {leading}
        </span>
        <span className="text-xs font-medium text-txt">{label}</span>
      </span>
      {selected ? (
        <Check
          aria-hidden="true"
          data-slot="selectable-tile-indicator"
          className="absolute right-1.5 top-1.5 size-3 text-accent"
        />
      ) : null}
    </Button>
  ),
);
SelectableTile.displayName = "SelectableTile";
