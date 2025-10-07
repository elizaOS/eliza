import { UUID } from '@elizaos/core';
import { Avatar, AvatarImage } from './ui/avatar';
import { formatAgentName } from '@/lib/utils';
import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface AgentAvatarStackProps {
  agentIds: UUID[];
  agentNames: string[];
  agentAvatars: Record<string, string | null>;
  size?: 'sm' | 'md' | 'lg';
  maxStack?: number;
  showExtraTooltip?: boolean;
}

export default function AgentAvatarStack({
  agentIds,
  agentNames,
  agentAvatars,
  size = 'md',
  maxStack = 2,
  showExtraTooltip = false,
}: AgentAvatarStackProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const displayAgents = agentIds.slice(0, maxStack);
  const isMultiple = displayAgents.length > 1;
  const hiddenCount = agentIds.length - maxStack;
  const showExtra = showExtraTooltip && agentIds.length > maxStack;

  const baseSize = size === 'sm' ? 24 : size === 'lg' ? 40 : 32;
  const avatarSizeClass = isMultiple
    ? size === 'sm'
      ? 'size-6'
      : size === 'lg'
        ? 'size-10'
        : 'size-8'
    : size === 'sm'
      ? 'size-6'
      : size === 'lg'
        ? 'size-10'
        : 'size-8';

  const visibleCount = showExtra ? maxStack + 1 : maxStack;
  const overlapFactor = showExtraTooltip ? 1 : 0.6;
  const avatarOffset = Math.floor(baseSize * (overlapFactor / visibleCount));

  const getAvatarContent = (agentId: UUID, index: number) => {
    const avatarSrc = agentAvatars[agentId] || '/elizaos-icon.png';
    return agentAvatars[agentId] ? (
      <AvatarImage src={avatarSrc} alt="Agent avatar" />
    ) : (
      <div className="rounded-full bg-gray-600 w-full h-full flex-shrink-0 flex items-center justify-center">
        {formatAgentName(agentNames[index])}
      </div>
    );
  };

  const handleMouseEnter = (index: number) => {
    if (showExtraTooltip) {
      setHoveredIndex(index);
    }
  };

  const handleMouseLeave = () => {
    setHoveredIndex(null);
  };

  return (
    <div
      className="relative flex items-center text-xs"
      style={{ height: baseSize, width: baseSize }}
    >
      {displayAgents.length === 1 ? (
        <Avatar className={`${avatarSizeClass} rounded-full overflow-hidden`}>
          {getAvatarContent(displayAgents[0], 0)}
        </Avatar>
      ) : (
        <>
          {displayAgents.map((agentId, index) => (
            <Avatar
              onMouseEnter={() => handleMouseEnter(index)}
              onMouseLeave={() => handleMouseLeave()}
              key={agentId}
              className={`${avatarSizeClass} rounded-full overflow-hidden absolute border border-2 border-card`}
              style={{
                zIndex: hoveredIndex === index ? agentIds.length + 1 : index,
                left: `${(index - (visibleCount - 1) / 2) * avatarOffset}px`,
                top: `${(index - (visibleCount - 1) / 2) * avatarOffset}px`,
              }}
            >
              {getAvatarContent(agentId, index)}
            </Avatar>
          ))}
          {showExtra && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={`${avatarSizeClass} rounded-full bg-gray-500 text-foreground/60 flex items-center justify-center absolute border border-2 border-card`}
                  style={{
                    zIndex: displayAgents.length,
                    left: `${(displayAgents.length - (visibleCount - 1) / 2) * avatarOffset}px`,
                    top: `${(displayAgents.length - (visibleCount - 1) / 2) * avatarOffset}px`,
                  }}
                >
                  +{hiddenCount}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="flex flex-col">
                  {agentNames.slice(maxStack).map((name, index) => (
                    <span key={index}>{name}</span>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}
    </div>
  );
}
