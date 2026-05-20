import { cn } from '@feed/shared';

interface SeparatorProps {
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}

export function Separator({
  className,
  orientation = 'horizontal',
}: SeparatorProps) {
  if (orientation === 'vertical') {
    return <div className={cn('h-full w-px bg-border', className)} />;
  }

  return <div className={cn('h-px w-full bg-border', className)} />;
}
