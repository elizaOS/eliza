/**
 * Select primitives over Radix `@radix-ui/react-select`, with themed trigger,
 * portal content, and items. Derived from shadcn/ui `select`
 * (https://ui.shadcn.com/docs/components/select); content is tagged with the
 * config-select floating-layer name so it stacks correctly inside config dialogs.
 */
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";

import { CONFIG_SELECT_FLOATING_LAYER_NAME } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

interface SelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  variant?:
    | "default"
    | "config"
    | "modal"
    | "settingsCompact"
    | "settingsFilter"
    | "settingsSoft"
    | "settingsToolbar"
    | "settingsTouch"
    | "form"
    | "accountCompact"
    | "connectorCompact"
    | "connectorLocal";
  density?: "default" | "compact" | "short";
  hasError?: boolean;
}

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(
  (
    {
      className,
      children,
      variant = "default",
      density = "default",
      hasError = false,
      ...props
    },
    ref,
  ) => (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex h-10 w-full items-center justify-between rounded-sm border border-input bg-bg px-3 py-2 text-sm placeholder:text-muted pointer-coarse:min-h-touch pointer-coarse:min-w-touch disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
        variant === "config" &&
          "border-border bg-card font-[var(--mono)] placeholder:text-muted placeholder:opacity-60",
        variant === "modal" &&
          "h-11 border-border bg-bg-hover text-txt placeholder:text-muted",
        variant === "settingsCompact" &&
          "h-9 rounded-sm border-border bg-card px-2.5 py-1.5 text-xs",
        variant === "settingsFilter" &&
          "h-10 rounded-sm border-border/50 bg-bg/80 px-3 py-2 text-left text-sm text-txt",
        variant === "settingsSoft" &&
          "rounded-sm border-border bg-bg px-2.5 py-1.5 text-xs",
        variant === "settingsToolbar" &&
          "h-11 rounded-sm border-border/60 bg-bg/70 text-left",
        variant === "settingsTouch" &&
          "h-11 rounded-md border-border bg-card px-3.5 text-left text-sm text-txt",
        variant === "form" &&
          "h-11 border-border bg-bg px-4 py-2 text-sm text-txt outline-none transition-colors hover:border-border-strong hover:bg-bg-hover data-[placeholder]:text-muted",
        variant === "accountCompact" && "h-8 border-border bg-card text-xs",
        variant === "connectorCompact" && "h-8 border-border bg-card text-xs",
        variant === "connectorLocal" &&
          "h-9 border-border/40 bg-bg text-sm text-txt",
        density === "compact" && "h-8 px-2 py-1 text-xs",
        density === "short" && "h-9 px-3 py-2 text-sm",
        hasError &&
          "border-destructive bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  ),
);
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1",
      className,
    )}
    {...props}
  >
    <ChevronUp className="size-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1",
      className,
    )}
    {...props}
  >
    <ChevronDown className="size-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName;

interface SelectContentProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> {
  variant?: "default" | "form";
}

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  SelectContentProps
>(
  (
    { className, children, position = "popper", variant = "default", ...props },
    ref,
  ) => (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        data-floating-layer={CONFIG_SELECT_FLOATING_LAYER_NAME}
        className={cn(
          "relative z-[12000] max-h-96 min-w-[8rem] overflow-hidden rounded-sm border border-border bg-card text-txt data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          position === "popper" &&
            "w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)] data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          variant === "form" && "border-border bg-card",
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  ),
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("py-1.5 pl-2 pr-2 text-sm font-semibold", className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

export interface SelectItemProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> {
  description?: React.ReactNode;
  variant?: "default" | "form";
}

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  SelectItemProps
>(
  (
    { className, children, description, variant = "default", ...props },
    ref,
  ) => (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        "flex w-full cursor-default select-none gap-1.5 rounded-sm py-1.5 pl-2 pr-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        description ? "items-start" : "items-center",
        variant === "form" &&
          "min-h-11 px-3 py-2.5 text-txt transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-txt-strong data-[state=checked]:bg-accent-subtle data-[state=checked]:text-txt-strong",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description ? (
          <span className="text-xs text-muted">{description}</span>
        ) : null}
      </div>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  ),
);
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
