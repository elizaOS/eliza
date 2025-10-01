import type { TraceRecord } from '@evilmartians/agent-prism-types';

import { cn } from '@/lib/utils';
import { useCallback, type KeyboardEvent } from 'react';

import { type AvatarProps } from '../Avatar.tsx';
import { Badge, type BadgeProps } from '../Badge.tsx';
import { PriceBadge } from '../PriceBadge.tsx';
import { TimestampBadge } from '../TimestampBadge.tsx';
import { TokensBadge } from '../TokensBadge.tsx';
import { TraceListItemHeader } from './TraceListItemHeader.tsx';

interface TraceListItemProps {
  trace: TraceRecord;
  badges?: Array<BadgeProps>;
  avatar?: AvatarProps;
  onClick?: () => void;
  isSelected?: boolean;
}

export const TraceListItem = ({
  trace,
  avatar,
  onClick,
  badges,
  isSelected,
}: TraceListItemProps) => {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick?.();
      }
    },
    [onClick]
  );

  const { name, agentDescription, totalCost, totalTokens, startTime } = trace;

  return (
    <div
      className={cn(
        'group w-full',
        'flex flex-col gap-2.5 p-4',
        'cursor-pointer',
        isSelected ? 'bg-muted' : 'bg-card'
      )}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-label={`Select trace ${name}`}
    >
      <TraceListItemHeader trace={trace} avatar={avatar} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-4 max-w-full truncate text-sm text-muted-foreground ">
          {agentDescription}
        </span>

        {typeof totalCost === 'number' && <PriceBadge cost={totalCost} />}

        {typeof totalTokens === 'number' && <TokensBadge tokensCount={totalTokens} />}

        {badges?.map((badge, index) => (
          <Badge key={index} theme={badge.theme} size="4" label={badge.label} />
        ))}

        {typeof startTime === 'number' && <TimestampBadge timestamp={startTime} />}
      </div>
    </div>
  );
};
