/**
 * Range slider over Radix `@radix-ui/react-slider`, themed to the kit tokens.
 * Derived from shadcn/ui `slider` (https://ui.shadcn.com/docs/components/slider).
 */
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as React from "react";

import { cn } from "../../lib/utils";

type SliderElement = React.ElementRef<typeof SliderPrimitive.Root>;
type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>;

const Slider: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<SliderProps> & React.RefAttributes<SliderElement>
> = React.forwardRef<SliderElement, SliderProps>(
  ({ className, ...props }, ref) => (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        "relative flex w-full touch-none select-none items-center",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-sm bg-input">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block h-5 w-5 rounded-sm border-2 border-primary bg-bg  transition-colors     disabled:pointer-events-none disabled:opacity-50" />
    </SliderPrimitive.Root>
  ),
);
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
