'use client'

import * as React from 'react'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

const TooltipProvider = RadixTooltip.Provider
const Tooltip = RadixTooltip.Root
const TooltipTrigger = RadixTooltip.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof RadixTooltip.Content>,
  React.ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <RadixTooltip.Portal>
    <RadixTooltip.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md border border-surface-700',
        'bg-surface-800 px-3 py-1.5 text-xs text-surface-100 shadow-md',
        'animate-scale-in data-[state=closed]:animate-scale-out',
        className
      )}
      {...props}
    />
  </RadixTooltip.Portal>
))
TooltipContent.displayName = RadixTooltip.Content.displayName

// Convenience wrapper
interface SimpleTooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  delayDuration?: number
  asChild?: boolean
}

function SimpleTooltip({
  content,
  children,
  side = 'top',
  delayDuration = 400,
  asChild = false,
}: SimpleTooltipProps) {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip>
        <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, SimpleTooltip }
