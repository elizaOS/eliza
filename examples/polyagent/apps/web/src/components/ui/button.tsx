import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Props for the Button component.
 */
export interface ButtonProps extends React.ComponentPropsWithoutRef<"button"> {
  /** Visual style variant */
  variant?: "default" | "outline" | "ghost" | "link";
  /** Size variant */
  size?: "default" | "sm" | "lg" | "icon";
}

const variantStyles: Record<NonNullable<ButtonProps["variant"]>, string> = {
  default:
    "bg-primary text-primary-foreground hover:bg-primary/90 border border-transparent",
  outline:
    "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  link: "text-primary underline-offset-4 hover:underline",
};

const sizeStyles: Record<NonNullable<ButtonProps["size"]>, string> = {
  default: "h-10 px-4 py-2",
  sm: "h-9 rounded-md px-3",
  lg: "h-11 rounded-md px-8",
  icon: "h-10 w-10",
};

/**
 * Button component for user interactions.
 *
 * A flexible button component that extends native button functionality
 * with variant and size options. Accepts all standard button props.
 *
 * @param props - Button component props
 * @returns Button element
 *
 * @example
 * ```tsx
 * <Button variant="default" size="lg" onClick={handleClick}>
 *   Click Me
 * </Button>
 * ```
 */
export const Button = ({
  children,
  variant = "default",
  size = "default",
  className,
  ...props
}: ButtonProps) => {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium text-sm ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
};

export const buttonVariants = (
  variant: ButtonProps["variant"] = "default",
  size: ButtonProps["size"] = "default",
) =>
  cn(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium text-sm ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    variantStyles[variant],
    sizeStyles[size],
  );
