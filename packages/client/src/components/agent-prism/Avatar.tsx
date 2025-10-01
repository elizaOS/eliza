import { cn } from '@/lib/utils';
import { User } from 'lucide-react';
import { useState, type ComponentPropsWithRef, type ReactElement } from 'react';

import { ROUNDED_CLASSES, type ColorVariant, type ComponentSize } from './shared.ts';

export type AvatarSize = Extract<ComponentSize, '4' | '6' | '8' | '9' | '10' | '11' | '12' | '16'>;

const sizeClasses: Record<AvatarSize, string> = {
  '4': 'size-4 text-xs',
  '6': 'size-6 text-xs',
  '8': 'size-8 text-xs',
  '9': 'size-9 text-sm',
  '10': 'size-10 text-base',
  '11': 'size-11 text-lg',
  '12': 'size-12 text-xl',
  '16': 'size-16 text-2xl',
};

const iconSizeClasses: Record<AvatarSize, string> = {
  '4': 'size-3',
  '6': 'size-4',
  '8': 'size-6',
  '9': 'size-7',
  '10': 'size-8',
  '11': 'size-9',
  '12': 'size-10',
  '16': 'size-12',
};

const textSizeClasses: Record<AvatarSize, string> = {
  '4': 'text-xs',
  '6': 'text-xs',
  '8': 'text-xs',
  '9': 'text-sm',
  '10': 'text-base',
  '11': 'text-lg',
  '12': 'text-xl',
  '16': 'text-2xl',
};

const bgColorClasses: Record<ColorVariant, string> = {
  gray: 'bg-muted-foreground',
  red: 'bg-destructive',
  orange: 'bg-chart-1',
  yellow: 'bg-chart-5',
  teal: 'bg-chart-2',
  indigo: 'bg-primary',
  purple: 'bg-primary',
  sky: 'bg-chart-4',
  cyan: 'bg-chart-3',
  emerald: 'bg-accent',
};

export type AvatarProps = ComponentPropsWithRef<'div'> & {
  /**
   * The image source for the avatar
   */
  src?: string;
  /**
   * The alt text for the avatar
   */
  alt?: string;
  /**
   * The size of the avatar
   * @default "md"
   */
  size?: AvatarSize;
  /**
   * The border radius of the avatar
   * @default "full"
   */
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'full';
  /**
   * Background color theme for the letter avatar
   * Uses the unified color theme system
   * @default "gray"
   */
  bgColor?: ColorVariant;
  /**
   * Text color for the letter avatar
   * @default "white"
   */
  textColor?: 'white' | 'black';
  /**
   * Custom letter to display (will use first letter of alt if not provided)
   */
  letter?: string;
  /**
   * Optional className for additional styling
   */
  className?: string;
};

export const Avatar = ({
  src,
  alt = 'Avatar',
  size = '10',
  rounded = 'full',
  bgColor = 'gray',
  textColor = 'white',
  letter,
  className = '',
  ...rest
}: AvatarProps): ReactElement => {
  const [error, setError] = useState(false);

  const displayLetter = letter ? letter.charAt(0) : alt.charAt(0).toUpperCase();

  const actualTextColor = textColor === 'white' ? 'text-white' : 'text-black';

  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden',
        'bg-muted',
        error && 'border border-border',
        sizeClasses[size],
        textSizeClasses[size],
        ROUNDED_CLASSES[rounded],
        className
      )}
      {...rest}
    >
      {error ? (
        <User className={cn(iconSizeClasses[size], 'text-muted-foreground')} />
      ) : (
        <>
          {src ? (
            <img
              src={src}
              alt={alt}
              className="h-full w-full object-cover"
              onError={() => setError(true)}
            />
          ) : (
            <div
              className={cn(
                'flex h-full w-full items-center justify-center',
                bgColorClasses[bgColor],
                actualTextColor,
                'font-medium'
              )}
            >
              {displayLetter}
            </div>
          )}
        </>
      )}
    </div>
  );
};
