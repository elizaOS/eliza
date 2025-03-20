import { UUID } from '@elizaos/core';
import { Avatar, AvatarImage } from './ui/avatar';

interface AgentAvatarStackProps {
  agentIds: UUID[];
  agentAvatars: Record<string, string | null>;
  maxDisplay?: number;
  size?: 'sm' | 'md' | 'lg';
}

export default function AgentAvatarStack({
  agentIds,
  agentAvatars,
  maxDisplay = 3,
  size = 'md',
}: AgentAvatarStackProps) {
  const displayAgents = agentIds.slice(0, maxDisplay);
  const remainingCount = agentIds.length - maxDisplay;

  // Size classes based on the size prop
  const avatarSizeClass = size === 'sm' ? 'size-6' : size === 'lg' ? 'size-10' : 'size-8';

  // Calculate overlap based on number of agents - more agents means more overlap
  const overlapFactor = 1.0 - 1.0 / displayAgents.length;
  const avatarSize = size === 'sm' ? 24 : size === 'lg' ? 40 : 32;
  const offsetPixels = Math.floor(avatarSize * overlapFactor);

  return (
    <div className="relative flex items-center">
      {displayAgents.map((agentId, index) => (
        <div
          key={agentId}
          className={`${avatarSizeClass} rounded-full border-2 border-background absolute`}
          style={{
            zIndex: displayAgents.length - index,
            left: `${index * offsetPixels}px`,
          }}
        >
          <Avatar className={`${avatarSizeClass} rounded-full overflow-hidden`}>
            <AvatarImage src={agentAvatars[agentId] || '/elizaos-icon.png'} alt="Agent avatar" />
          </Avatar>
        </div>
      ))}

      {remainingCount > 0 && (
        <div
          className={`${avatarSizeClass} rounded-full bg-muted flex items-center justify-center border-2 border-background absolute`}
          style={{
            zIndex: 0,
            left: `${displayAgents.length * offsetPixels}px`,
          }}
        >
          <span className="text-xs font-medium">+{remainingCount}</span>
        </div>
      )}

      {/* Empty div to maintain proper spacing in the layout */}
      <div
        style={{
          width: `${(displayAgents.length + (remainingCount > 0 ? 1 : 0)) * offsetPixels - (offsetPixels - avatarSize)}px`,
          height: avatarSizeClass,
          paddingRight: displayAgents.length > 1 ? '5px' : '0px',
        }}
      ></div>
    </div>
  );
}
