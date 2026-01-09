import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Icon, type IconButtonIcon } from './Icon';
import type { ComponentSize } from './shared';

type IconButtonSize = Extract<ComponentSize, '6' | '7' | '8' | '9' | '10' | '11' | '12' | '16'>;
type IconButtonVariant = 'default' | 'ghost';

/**
 * Map button sizes to appropriate icon sizes for visual balance
 */
const buttonSizeToIconSize: Record<IconButtonSize, '4' | '5' | '6'> = {
  '6': '4',
  '7': '4',
  '8': '5',
  '9': '5',
  '10': '6',
  '11': '6',
  '12': '6',
  '16': '6',
};

type IconButtonBaseProps = ComponentPropsWithRef<'button'> & {
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

  /**
   * Custom className for the icon (only used with icon prop)
   */
  iconClassName?: string;
};

/**
 * IconButton with icon prop - preferred usage
 */
type IconButtonWithIconProp = IconButtonBaseProps & {
  /**
   * The Lucide icon component to render
   */
  icon: IconButtonIcon;
  children?: never;
};

/**
 * IconButton with children - backward compatible usage
 */
type IconButtonWithChildren = IconButtonBaseProps & {
  icon?: never;
  /**
   * @deprecated Use the `icon` prop instead for consistent styling
   */
  children: ReactNode;
};

export type IconButtonProps = IconButtonWithIconProp | IconButtonWithChildren;

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
  default: 'border border-border bg-transparent',
  ghost: 'bg-transparent',
};

/**
 * A button component specifically designed for icon-only actions.
 * Supports both direct icon prop (preferred) and children (for backward compatibility).
 *
 * @example Using icon prop (preferred)
 * ```tsx
 * import { Copy } from 'lucide-react';
 *
 * <IconButton icon={Copy} aria-label="Copy to clipboard" />
 * <IconButton icon={Copy} aria-label="Copy" size="8" variant="ghost" />
 * ```
 *
 * @example Using children (backward compatible)
 * ```tsx
 * import { Copy } from 'lucide-react';
 *
 * <IconButton aria-label="Copy to clipboard">
 *   <Copy className="size-3.5" />
 * </IconButton>
 * ```
 */
export const IconButton = ({
  children,
  icon,
  className,
  iconClassName,
  size = '6',
  variant = 'default',
  type = 'button',
  'aria-label': ariaLabel,
  ...rest
}: IconButtonProps) => {
  const iconSize = buttonSizeToIconSize[size];

  return (
    <button
      type={type}
      aria-label={ariaLabel}
      className={cn(
        sizeClasses[size],
        'inline-flex aspect-square shrink-0 items-center justify-center',
        'rounded-md',
        variantClasses[variant],
        'text-muted-foreground',
        'hover:bg-gray-200 dark:hover:bg-gray-800',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        className
      )}
      {...rest}
    >
      {icon ? (
        <Icon icon={icon} size={iconSize} className={cn('text-muted-foreground', iconClassName)} />
      ) : (
        children
      )}
    </button>
  );
};
