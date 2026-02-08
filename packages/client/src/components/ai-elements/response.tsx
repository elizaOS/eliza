'use client';

import { cn } from '@/lib/utils';
import { type ComponentProps, memo } from 'react';
import { Streamdown } from 'streamdown';

type ResponseProps = ComponentProps<typeof Streamdown>;

export const Response = memo(
  ({ className, shikiTheme = ['github-dark', 'github-dark'], ...props }: ResponseProps) => (
    <Streamdown
      className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      shikiTheme={shikiTheme}
      {...props}
    />
  ),
  (prevProps, nextProps) => {
    // Compare all props that affect rendering
    return (
      prevProps.children === nextProps.children &&
      prevProps.className === nextProps.className &&
      prevProps.isAnimating === nextProps.isAnimating &&
      JSON.stringify(prevProps.shikiTheme) === JSON.stringify(nextProps.shikiTheme)
    );
  }
);

Response.displayName = 'Response';
