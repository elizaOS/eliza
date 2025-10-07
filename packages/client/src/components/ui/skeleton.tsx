import { cn } from '@/lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  'data-testid'?: string;
}

function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-primary/10', className)}
      data-testid={props['data-testid'] || 'skeleton'}
      {...props}
    />
  );
}

export { Skeleton };
