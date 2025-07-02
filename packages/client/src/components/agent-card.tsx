import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { formatAgentName, cn } from '@/lib/utils';
import type { Agent } from '@elizaos/core';
import { AgentStatus as CoreAgentStatus } from '@elizaos/core';
import { MessageSquare, Settings, Loader2 } from 'lucide-react';
import { useAgentManagement } from '@/hooks/use-agent-management';
import type { AgentWithStatus } from '@/types';
import clientLogger from '@/lib/logger';

interface AgentCardProps {
  agent: Partial<AgentWithStatus>;
  onChat: (agent: Partial<AgentWithStatus>) => void;
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, onChat }) => {
  const navigate = useNavigate();
  const { startAgent, stopAgent, isAgentStarting, isAgentStopping } = useAgentManagement();

  if (!agent || !agent.id) {
    clientLogger.error('[AgentCard] Agent data or ID is missing', { agent });
    return (
      <Card className="p-4 min-h-[120px] flex items-center justify-center text-muted-foreground">
        Agent data not available.
      </Card>
    );
  }

  const agentIdForNav = agent.id;
  const agentName = agent.name || 'Unnamed Agent';
  const avatarUrl = typeof agent.settings?.avatar === 'string' ? agent.settings.avatar : undefined;
  const description =
    (typeof agent.bio === 'string' && agent.bio.trim()) ||
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

  const handleNewChat = () => {
    onChat(agent);
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
        'w-full transition-all hover:shadow-lg cursor-pointer bg-card overflow-hidden',
        isActive ? '' : 'opacity-75 hover:opacity-100'
      )}
      onClick={handleNewChat}
      data-testid="agent-card"
    >
      <CardContent className="p-4">
        {/* Top section with avatar, name, description and toggle */}
        <div className="flex items-start gap-3 mb-4">
          {/* Avatar */}
          <Avatar className="h-16 w-16 flex-shrink-0 rounded-lg">
            <AvatarImage src={avatarUrl} alt={agentName} />
            <AvatarFallback className="text-lg font-medium">
              {formatAgentName(agentName)}
            </AvatarFallback>
          </Avatar>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Name */}
            <h3 className="font-semibold text-lg mb-2" title={agentName}>
              {agentName}
            </h3>

            {/* Description */}
            <div className="h-10 flex items-start">
              <p
                className="text-sm text-muted-foreground leading-5 overflow-hidden"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                {description}
              </p>
            </div>
          </div>

          {/* Toggle Switch */}
          <div className="flex-shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleToggle();
              }}
              disabled={isStarting || isStopping}
              className={cn(
                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500',
                isActive ? 'bg-green-500' : 'bg-red-500'
              )}
              role="switch"
              aria-checked={isActive}
              aria-label={`Toggle ${agentName}`}
            >
              {isStarting || isStopping ? (
                <Loader2 className="h-4 w-4 animate-spin text-white mx-auto" />
              ) : (
                <span
                  className={cn(
                    'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                    isActive ? 'translate-x-6' : 'translate-x-1'
                  )}
                />
              )}
            </button>
          </div>
        </div>

        {/* Bottom section with settings and new chat buttons */}
        <div className="flex items-center justify-between">
          {/* Settings button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleSettings();
            }}
            className="h-8 px-2"
          >
            <Settings className="h-4 w-4" />
          </Button>

          {/* New Chat button */}
          <Button
            variant="default"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleNewChat();
            }}
            className="h-8 px-3"
          >
            <MessageSquare className="h-4 w-4 mr-2" />
            New Chat
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default AgentCard;
