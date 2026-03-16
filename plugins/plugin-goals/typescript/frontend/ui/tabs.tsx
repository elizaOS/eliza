import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
<<<<<<<< HEAD:packages/ui/src/components/ui/tabs.tsx

import { cn } from "../../lib/utils";
========
import { cn } from "../utils";
>>>>>>>> origin/odi-dev:plugins/plugin-goals/typescript/frontend/ui/tabs.tsx

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
<<<<<<<< HEAD:packages/ui/src/components/ui/tabs.tsx
      "inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-fg",
      className,
========
      "inline-flex overflow-x-auto max-w-full h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
      className
>>>>>>>> origin/odi-dev:plugins/plugin-goals/typescript/frontend/ui/tabs.tsx
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
<<<<<<<< HEAD:packages/ui/src/components/ui/tabs.tsx
      "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-bg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-bg data-[state=active]:text-txt data-[state=active]:shadow-sm",
      className,
========
      "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow",
      className
>>>>>>>> origin/odi-dev:plugins/plugin-goals/typescript/frontend/ui/tabs.tsx
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
<<<<<<<< HEAD:packages/ui/src/components/ui/tabs.tsx
      "mt-2 ring-offset-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
========
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
>>>>>>>> origin/odi-dev:plugins/plugin-goals/typescript/frontend/ui/tabs.tsx
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
