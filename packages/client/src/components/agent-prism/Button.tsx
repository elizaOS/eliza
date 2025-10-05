import type { ComponentPropsWithRef, ReactElement } from 'react';

import { cn } from '@/lib/utils';

import { ROUNDED_CLASSES, type ColorVariant, type ComponentSize } from './shared.ts';

type ButtonSize = Extract<ComponentSize, '6' | '7' | '8' | '9' | '10' | '11' | '12' | '16'>;

const BASE_CLASSES =
  'inline-flex items-center justify-center font-medium transition-all duration-200';

const sizeClasses = {
  '6': 'h-6 px-2 gap-1 text-xs',
  '7': 'h-7 px-2 gap-1 text-xs',
  '8': 'h-8 px-2 gap-1 text-xs',
  '9': 'h-9 px-2.5 gap-2 text-sm',
  '10': 'h-10 px-4 gap-2 text-sm',
  '11': 'h-11 px-5 gap-3 text-base',
  '12': 'h-12 px-5 gap-2.5 text-base',
  '16': 'h-16 px-7 gap-3 text-lg',
};

const filledThemeClasses: Record<ColorVariant, string> = {
  gray: 'bg-muted text-muted-foreground',
  purple: 'bg-primary text-primary-foreground',
  indigo: 'bg-primary text-primary-foreground',
  orange: 'bg-chart-1 text-primary-foreground',
  teal: 'bg-chart-2 text-primary-foreground',
  cyan: 'bg-chart-3 text-primary-foreground',
  sky: 'bg-chart-4 text-primary-foreground',
  yellow: 'bg-chart-5 text-primary-foreground',
  emerald: 'bg-accent text-accent-foreground',
  red: 'bg-destructive text-destructive-foreground',
};

const variantClasses = {
  filled: '',
  outlined: 'border border-2 bg-transparent text-foreground border-border',
  ghost: 'bg-transparent text-muted-foreground',
};

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  /**
   * The size of the button
   * @default "6"
   */
  size?: ButtonSize;

  /**
   * The color theme of the button
   * @default "gray"
   */
  theme?: ColorVariant;

  /**
   * The border radius of the button
   * @default "md"
   */
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'full';

  /**
   * The visual variant of the button
   * @default "filled"
   */
  variant?: 'filled' | 'outlined' | 'ghost';

  /**
   * Makes the button full width
   * @default false
   */
  fullWidth?: boolean;

  /**
   * Optional icon to display at the start of the button
   */
  iconStart?: ReactElement;

  /**
   * Optional icon to display at the end of the button
   */
  iconEnd?: ReactElement;
};

export const Button = ({
  children,
  size = '6',
  theme = 'gray',
  rounded = 'md',
  variant = 'filled',
  fullWidth = false,
  disabled = false,
  iconStart,
  iconEnd,
  type = 'button',
  onClick,
  className = '',
  ...rest
}: ButtonProps) => {
  const widthClass = fullWidth ? 'w-full' : '';
  const stateClasses = disabled ? 'cursor-not-allowed opacity-50' : 'hover:opacity-70';
  const filledThemeClass =
    variant === 'filled' ? filledThemeClasses[theme] || filledThemeClasses.gray : '';

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        BASE_CLASSES,
        sizeClasses[size],
        ROUNDED_CLASSES[rounded],
        variantClasses[variant],
        filledThemeClass,
        widthClass,
        stateClasses,
        className
      )}
      {...rest}
    >
      {iconStart && <span className="mr-1">{iconStart}</span>}
      {children}
      {iconEnd && <span className="ml-1">{iconEnd}</span>}
    </button>
  );
};
