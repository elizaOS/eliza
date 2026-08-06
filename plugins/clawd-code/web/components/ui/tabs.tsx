'use client'

import * as React from 'react'
import * as RadixTabs from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

const Tabs = RadixTabs.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof RadixTabs.List>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.List>
>(({ className, ...props }, ref) => (
  <RadixTabs.List
    ref={ref}
    className={cn(
      'relative inline-flex items-center border-b border-surface-800 w-full',
      className
    )}
    {...props}
  />
))
TabsList.displayName = RadixTabs.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof RadixTabs.Trigger>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
>(({ className, ...props }, ref) => (
  <RadixTabs.Trigger
    ref={ref}
    className={cn(
      'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
      'px-4 py-2.5 text-sm font-medium',
      'text-surface-500 transition-colors duration-[var(--transition-fast)]',
      'hover:text-surface-200',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset',
      'disabled:pointer-events-none disabled:opacity-50',
      // Animated underline via pseudo-element
      'after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full',
      'after:scale-x-0 after:bg-brand-500 after:transition-transform after:duration-[var(--transition-normal)]',
      'data-[state=active]:text-surface-50 data-[state=active]:after:scale-x-100',
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = RadixTabs.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof RadixTabs.Content>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.Content>
>(({ className, ...props }, ref) => (
  <RadixTabs.Content
    ref={ref}
    className={cn(
      'mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'data-[state=active]:animate-fade-in',
      className
    )}
    {...props}
  />
))
TabsContent.displayName = RadixTabs.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
