import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import type { UUID, Agent } from '@elizaos/core';
import type { MessageChannel as ClientMessageChannel } from '@/types';
import { Settings } from 'lucide-react';
import { formatAgentName, generateGroupName, getEntityId } from '@/lib/utils';
import GroupPanel from './group-panel';
import { useAgentsWithDetails, useChannelParticipants } from '@/hooks/use-query-hooks';

// The group prop will be a central channel, enriched with server_id for navigation context
// Assume group.participants might be available or added later.
interface GroupCardProps {
  group: ClientMessageChannel & { server_id: UUID; participants?: Partial<Agent>[] };
  // onEdit?: (group: ClientMessageChannel) => void;
}

const GroupCard: React.FC<GroupCardProps> = ({ group /*, onEdit */ }) => {
  const navigate = useNavigate();
  const currentClientId = getEntityId(); // Get current client/user ID
  const [showGroupPanel, setShowGroupPanel] = useState(false);

  if (!group || !group.id) {
    return (
      <Card className="p-4 min-h-[180px] flex items-center justify-center text-muted-foreground">
        Group data not available.
      </Card>
    );
  }

  const groupName = generateGroupName(group, group.participants || [], currentClientId);

  const handleChatClick = () => {
    navigate(`/group/${group.id}?serverId=${group.server_id}`);
  };

  const { data: agentsData } = useAgentsWithDetails();
  const allAgents = agentsData?.agents || [];

  const { data: participantsData } = useChannelParticipants(group.id);
  const participants = participantsData?.data;
  const participantsIds: UUID[] = participants && Array.isArray(participants) ? participants : [];

  const groupAgents = participantsIds
    ? allAgents.filter((agent) => participantsIds.includes(agent.id))
    : [];

  const handleSettings = () => {
    setShowGroupPanel(true);
  };

  const agentNames =
    groupAgents
      .map((agent) => agent.name)
      .filter(Boolean)
      .join(', ') || 'No members';

  return (
    <>
      <Card
        className="w-full transition-all bg-card border border-border/50 rounded-sm"
        data-testid="agent-card"
      >
        <CardContent className="p-0 relative h-full">
          <div className="flex flex-col justify-between h-full">
            <div className="flex items-center gap-4 p-2 h-[90%]">
              {/* Avatar */}
              <Avatar className="bg-[#282829] h-16 w-16 flex-shrink-0 rounded-[3px] relative overflow-hidden">
                {groupAgents && groupAgents.length > 0 ? (
                  <div className="grid grid-cols-2 grid-rows-2 gap-1 w-full h-full p-1">
                    {groupAgents.slice(0, 3).map((agent) =>
                      agent.settings?.avatar ? (
                        <img
                          key={agent.id}
                          src={agent.settings.avatar}
                          alt={agent.name}
                          className="object-cover w-full h-full rounded-[3px]"
                        />
                      ) : (
                        <div
                          key={agent.id}
                          className="flex items-center justify-center bg-[#3F3F3F] text-xs font-medium w-full h-full rounded-[3px]"
                        >
                          {formatAgentName(agent.name)}
                        </div>
                      )
                    )}
                    {groupAgents.length > 3 ? (
                      <div className="flex items-center justify-center bg-[#3F3F3F] text-xs font-medium w-full h-full rounded-[3px]">
                        +{groupAgents.length - 3}
                      </div>
                    ) : (
                      Array.from({ length: 4 - groupAgents.slice(0, 3).length }).map((_, idx) => (
                        <div
                          key={`empty-${idx}`}
                          className="flex items-center justify-center bg-[#2D2D2D] text-xs font-medium w-full h-full rounded-[3px]"
                        ></div>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center bg-muted text-lg font-medium w-full h-full">
                    {formatAgentName(groupName)}
                  </div>
                )}
              </Avatar>

              {/* Content - Name and Description */}
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-xl mb-1 truncate" title={groupName}>
                  {groupName}
                </h3>
                <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
                  {agentNames}
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
                  handleChatClick();
                }}
                className="h-8 px-2 rounded-sm bg-muted hover:bg-muted/50 cursor-pointer"
              >
                Chat
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      {showGroupPanel && (
        <GroupPanel onClose={() => setShowGroupPanel(false)} channelId={group.id} />
      )}
    </>
  );
};

export default GroupCard;
