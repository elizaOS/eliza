import type { ComponentPropsWithRef, ReactElement, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { COLOR_THEME_CLASSES, type ColorVariant, type ComponentSize } from './shared.ts';

type BadgeSize = Extract<ComponentSize, '4' | '5' | '6' | '7'>;

const sizeClasses: Record<BadgeSize, string> = {
  '4': 'px-1 gap-1 h-4',
  '5': 'px-1.5 gap-1 h-5',
  '6': 'px-2 gap-1.5 h-6',
  '7': 'px-2.5 gap-2 h-7',
};

const textSizes: Record<BadgeSize, string> = {
  '4': 'text-xs font-normal leading-3',
  '5': 'text-xs font-medium',
  '6': 'text-sm font-medium',
  '7': 'text-sm font-medium',
};

export type BadgeProps = ComponentPropsWithRef<'span'> & {
  /**
   * The content of the badge
   */
  label: ReactNode;

  /**
   * The color theme of the badge
   * Uses the unified color theme system
   * @default "gray"
   */
  theme: ColorVariant;

  /**
   * The visual variant of the badge
   * @default "solid"
   */
  variant?: 'solid' | 'outline';

  /**
   * The size of the badge
   * @default "md"
   */
  size?: BadgeSize;

  /**
   * Optional icon to display at the start of the badge
   */
  iconStart?: ReactElement;

  /**
   * Optional icon to display at the end of the badge
   */
  iconEnd?: ReactElement;

  /**
   * Optional className for additional styling
   */
  className?: string;
};

export const Badge = ({
  label,
  theme = 'gray',
  variant = 'solid',
  size = '4',
  iconStart,
  iconEnd,
  className = '',
  ...rest
}: BadgeProps): ReactElement => {
  const { bg, darkBg, text, darkText } = COLOR_THEME_CLASSES[theme];

  const variantClasses =
    variant === 'outline'
      ? `border ${text} ${darkText} bg-transparent dark:bg-transparent border-current`
      : `${bg} ${text} ${darkBg} ${darkText}`;

  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center overflow-hidden rounded font-medium',
        variantClasses,
        sizeClasses[size],
        className
      )}
      {...rest}
    >
      {iconStart && <span className="shrink-0">{iconStart}</span>}

      <span
        className={cn(textSizes[size], 'min-w-0 max-w-full flex-shrink-0 truncate tracking-normal')}
      >
        {label}
      </span>

      {iconEnd && <span className="shrink-0">{iconEnd}</span>}
    </span>
  );
};
