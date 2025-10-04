import type { ComponentPropsWithRef } from 'react';

import { cn } from '@/lib/utils';

import type { ComponentSize } from './shared';

type IconButtonSize = Extract<ComponentSize, '6' | '7' | '8' | '9' | '10' | '11' | '12' | '16'>;
type IconButtonVariant = 'default' | 'ghost';

export type IconButtonProps = ComponentPropsWithRef<'button'> & {
  /**
   * The size of the icon button
   */
  size?: IconButtonSize;

  /**
   * The visual variant of the icon button
   */
  variant?: IconButtonVariant;

  /**
   * Accessible label for screen readers
   * Required for accessibility compliance
   */
  'aria-label': string;
};

const sizeClasses: Record<IconButtonSize, string> = {
  '6': 'h-6 min-h-6',
  '7': 'h-7 min-h-7',
  '8': 'h-8 min-h-8',
  '9': 'h-9 min-h-9',
  '10': 'h-10 min-h-10',
  '11': 'h-11 min-h-11',
  '12': 'h-12 min-h-12',
  '16': 'h-16 min-h-16',
};

const variantClasses: Record<IconButtonVariant, string> = {
  default: 'border border-border bg-transparent ',
  ghost: 'bg-transparent',
};

// TODO: Remake to call Icon component directly instead of passing children
export const IconButton = ({
  children,
  className,
  size = '6',
  variant = 'default',
  type = 'button',
  'aria-label': ariaLabel,
  ...rest
}: IconButtonProps) => {
  return (
    <button
      type={type}
      aria-label={ariaLabel}
      className={cn(
        className,
        sizeClasses[size],
        'inline-flex aspect-square shrink-0 items-center justify-center',
        'rounded-md',
        variantClasses[variant],
        'text-muted-foreground ',
        'hover:bg-gray-200 dark:hover:bg-gray-800'
      )}
      {...rest}
    >
      {children}
    </button>
  );
};
