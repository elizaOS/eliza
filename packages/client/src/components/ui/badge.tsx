import { type VariantProps, cva } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-none border px-2.5 py-0.5 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-interactive-primary focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-surface-raised text-text-primary hover:bg-interactive-hover',
        secondary:
          'border-transparent bg-surface-overlay text-text-primary hover:bg-interactive-hover',
        destructive:
          'border-transparent bg-status-error text-text-primary hover:bg-status-error/80',
        outline: 'text-text-primary border-border-subtle hover:bg-interactive-hover',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
