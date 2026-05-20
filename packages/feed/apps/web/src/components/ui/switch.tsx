import { cn } from '@babylon/shared';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import * as React from 'react';

/**
 * Switch component for toggle inputs.
 *
 * Toggle switch component built on Radix UI Switch primitive.
 * Includes thumb animation and checked/unchecked states.
 *
 * @param props - Switch component props
 * @returns Switch element
 *
 * @example
 * ```tsx
 * <Switch checked={enabled} onCheckedChange={setEnabled} />
 * ```
 */
function Switch({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof SwitchPrimitives.Root>) {
  return (
    <SwitchPrimitives.Root
      className={cn(
        'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-transparent data-[state=unchecked]:border-border data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted',
        className
      )}
      {...props}
      ref={ref}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          'pointer-events-none block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0 dark:data-[state=unchecked]:bg-neutral-300'
        )}
      />
    </SwitchPrimitives.Root>
  );
}
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
