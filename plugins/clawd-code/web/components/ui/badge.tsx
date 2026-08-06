import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-surface-800 text-surface-300 border border-surface-700',
        success: 'bg-success-bg text-success border border-success/20',
        error: 'bg-error-bg text-error border border-error/20',
        warning: 'bg-warning-bg text-warning border border-warning/20',
        info: 'bg-info-bg text-info border border-info/20',
        brand: 'bg-brand-500/15 text-brand-300 border border-brand-500/25',
        outline: 'border border-surface-600 text-surface-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean
}

function Badge({ className, variant, dot = false, children, ...props }: BadgeProps) {
  const dotColors: Record<string, string> = {
    default: 'bg-surface-400',
    success: 'bg-success',
    error: 'bg-error',
    warning: 'bg-warning',
    info: 'bg-info',
    brand: 'bg-brand-400',
    outline: 'bg-surface-500',
  }
  const dotColor = dotColors[variant ?? 'default'] ?? dotColors.default

  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props}>
      {dot && (
        <span
          className={cn('h-1.5 w-1.5 rounded-full flex-shrink-0', dotColor)}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  )
}

export { Badge, badgeVariants }
