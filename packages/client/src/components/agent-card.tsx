import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { formatAgentName, cn, getAgentAvatar, getAgentStatus } from '@/lib/utils';
import type { Agent } from '@elizaos/core';
import { AgentStatus as CoreAgentStatus } from '@elizaos/core';
import { Settings } from 'lucide-react';
import { useAgentManagement } from '@/hooks/use-agent-management';
import clientLogger from '@/lib/logger';

interface AgentCardProps {
  agent: Agent;
  onChat: (forceNew: boolean) => void;
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, onChat }) => {
  const navigate = useNavigate();
  const { startAgent, stopAgent, isAgentStarting, isAgentStopping } = useAgentManagement();

  if (!agent || !agent.id) {
    clientLogger.error('[AgentCard] Agent data or ID is missing', { agent });
    return (
      <Card className="p-4 min-h-[100px] flex items-center justify-center text-muted-foreground">
        Agent data not available.
      </Card>
    );
  }

  const agentIdForNav = agent.id;
  const agentName = agent.name || 'Unnamed Agent';

  const description = Array.isArray(agent.bio)
    ? agent.bio.filter(Boolean).join(' ').trim()
    : (typeof agent.bio === 'string' && agent.bio.trim()) ||
      'Engages with all types of questions and conversations';
  const isActive = agent.status === CoreAgentStatus.ACTIVE;
  const isStarting = isAgentStarting(agent.id);
  const isStopping = isAgentStopping(agent.id);

  const agentForMutation: Agent = {
    id: agent.id!,
    name: agentName,
    username: agent.username || agentName,
    bio: agent.bio || '',
    messageExamples: agent.messageExamples || [],
    postExamples: agent.postExamples || [],
    topics: agent.topics || [],
    adjectives: agent.adjectives || [],
    knowledge: agent.knowledge || [],
    plugins: agent.plugins || [],
    settings: agent.settings || {},
    secrets: agent.secrets || {},
    style: agent.style || {},
    system: agent.system || undefined,
    templates: agent.templates || {},
    enabled: typeof agent.enabled === 'boolean' ? agent.enabled : true,
    status: agent.status || CoreAgentStatus.INACTIVE,
    createdAt: typeof agent.createdAt === 'number' ? agent.createdAt : Date.now(),
    updatedAt: typeof agent.updatedAt === 'number' ? agent.updatedAt : Date.now(),
  };

  const handleStart = () => {
    startAgent(agentForMutation);
  };

  const handleStop = () => {
    stopAgent(agentForMutation);
  };

  const handleNewChat = (forceNew: boolean = false) => {
    onChat(forceNew);
  };

  const handleSettings = () => {
    navigate(`/settings/${agentIdForNav}`);
  };

  const handleToggle = () => {
    if (isActive) {
      handleStop();
    } else {
      handleStart();
    }
  };

  return (
    <Card
      className={cn(
        'w-full transition-all bg-card border border-border/50 rounded-sm hover:bg-card/50 cursor-pointer',
        isActive ? '' : 'opacity-75'
      )}
      data-testid="agent-card"
      onClick={(e) => {
        e.stopPropagation();
        handleNewChat();
      }}
    >
      <CardContent className="p-0 relative h-full">
        {/* Toggle Switch - positioned absolutely in top-right */}
        <div className="absolute top-3 right-3">
          <Switch
            checked={isActive}
            onCheckedChange={(checked) => {
              if (checked !== isActive) {
                handleToggle();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Toggle ${agentName}`}
            disabled={isStarting || isStopping}
            className={cn(
              isActive
                ? 'data-[state=checked]:!bg-green-600'
                : 'data-[state=unchecked]:!bg-gray-500/80'
            )}
          />
        </div>

        <div className="flex flex-col justify-between h-full">
          <div className="flex items-center gap-4 p-2 h-[90%]">
            {/* Avatar */}
            <Avatar className="h-16 w-16 flex-shrink-0 rounded-sm">
              <AvatarImage src={getAgentAvatar(agent)} alt={agentName} />
              <AvatarFallback className="text-lg font-medium rounded-sm">
                {formatAgentName(agentName)}
              </AvatarFallback>
            </Avatar>

            {/* Content - Name and Description */}
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-xl mb-1 truncate" title={agentName}>
                {agentName}
              </h3>
              <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
                {description}
              </p>
            </div>
          </div>
          <div className="border-t border-muted" />
          <div className="flex items-center justify-between py-1 px-2">
            {/* Settings button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleSettings();
              }}
              className="h-8 w-8 p-0 hover:bg-muted/50 cursor-pointer"
            >
              <Settings className="h-4 w-4 text-muted-foreground" />
            </Button>

            {/* New Chat button - ghost variant */}
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleNewChat(true);
              }}
              className="h-8 px-2 rounded-sm bg-muted hover:bg-muted/50 cursor-pointer"
            >
              New Chat
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default AgentCard;
