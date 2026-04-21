import { Plus } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Button, type ButtonProps } from "./button";

export interface NewActionButtonProps extends Omit<ButtonProps, "variant"> {}

function normalizeNewActionLabel(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) =>
    typeof child === "string" ? child.replace(/^\+\s*/, "") : child,
  );
}

const NewActionButton = React.forwardRef<
  HTMLButtonElement,
  NewActionButtonProps
>(({ className, children, ...props }, ref) => {
  return (
    <Button
      ref={ref}
      variant="surfaceAccent"
      className={cn(
        "min-h-touch w-full justify-start rounded-xl px-4 py-2.5 text-sm font-medium",
        className,
      )}
      {...props}
    >
      <Plus className="h-4 w-4" />
      {normalizeNewActionLabel(children)}
    </Button>
  );
});

NewActionButton.displayName = "NewActionButton";

export { NewActionButton };
