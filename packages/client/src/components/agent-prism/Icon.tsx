import type { LucideIcon, LucideProps } from 'lucide-react';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '@/lib/utils';

import type { ComponentSize } from './shared';

type IconSize = Extract<ComponentSize, '4' | '5' | '6' | '7' | '8' | '9' | '10'>;

export interface IconProps extends Omit<LucideProps, 'size'> {
  /**
   * The Lucide icon component to render
   */
  icon: LucideIcon;

  /**
   * The size of the icon (maps to Tailwind size classes)
   */
  size?: IconSize;
}

/**
 * Size mapping from component size to Tailwind class
 */
const sizeClasses: Record<IconSize, string> = {
  '4': 'size-4',
  '5': 'size-5',
  '6': 'size-6',
  '7': 'size-7',
  '8': 'size-8',
  '9': 'size-9',
  '10': 'size-10',
};

/**
 * Icon component that wraps Lucide icons with consistent sizing and styling.
 *
 * @example
 * ```tsx
 * import { Check, Copy } from 'lucide-react';
 *
 * <Icon icon={Check} size="4" />
 * <Icon icon={Copy} size="6" className="text-muted-foreground" />
 * ```
 */
export const Icon = ({ icon: IconComponent, size = '4', className, ...rest }: IconProps) => {
  return <IconComponent className={cn(sizeClasses[size], className)} {...rest} />;
};

/**
 * Type for IconButton's icon prop - accepts any LucideIcon component
 */
export type IconButtonIcon = LucideIcon;
