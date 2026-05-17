import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
declare const TooltipProvider: React.FC<TooltipPrimitive.TooltipProviderProps>;
declare const Tooltip: React.FC<TooltipPrimitive.TooltipProps>;
declare const TooltipTrigger: React.ForwardRefExoticComponent<TooltipPrimitive.TooltipTriggerProps & React.RefAttributes<HTMLButtonElement>>;
declare const TooltipContent: React.ForwardRefExoticComponent<Omit<TooltipPrimitive.TooltipContentProps & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
export interface TooltipHintProps {
    children: React.ReactNode;
    content: React.ReactNode;
    side?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>["side"];
    sideOffset?: number;
    contentClassName?: string;
    delayDuration?: number;
    skipDelayDuration?: number;
}
export declare function TooltipHint({ children, content, side, sideOffset, contentClassName, delayDuration, skipDelayDuration, }: TooltipHintProps): import("react/jsx-runtime").JSX.Element;
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
//# sourceMappingURL=tooltip.d.ts.map