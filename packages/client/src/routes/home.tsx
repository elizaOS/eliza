import PageTitle from '@/components/page-title';
import ProfileOverlay from '@/components/profile-overlay';
import {
  useAgentsWithDetails,
  useChannels,
  useServers,
} from '@/hooks/use-query-hooks';
import { getEntityId } from '@/lib/utils';
import { type Agent, type UUID, ChannelType as CoreChannelType } from '@elizaos/core';
import { Plus } from 'lucide-react';
import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AddAgentCard from '@/components/add-agent-card';
import AgentCard from '@/components/agent-card';
import GroupCard from '@/components/group-card';
import GroupPanel from '@/components/group-panel';
import { apiClient } from '@/lib/api';
import { Button } from '../components/ui/button';
import { Separator } from '../components/ui/separator';
import clientLogger from '@/lib/logger';

/**
 * Renders the main dashboard for managing agents and groups, providing interactive controls for viewing, starting, messaging, and configuring agents, as well as creating and editing groups.
 *
 * Displays lists of agents and groups with status indicators, action buttons, and overlays for detailed views and settings. Handles loading and error states, and supports navigation to chat and settings pages.
 */
export default function Home() {
  const { data: agentsData, isLoading, isError, error } = useAgentsWithDetails();
  const navigate = useNavigate();
  const currentClientEntityId = getEntityId();

  // Extract agents properly from the response
  const agents = agentsData?.agents || [];

  const { data: serversData, isLoading: isLoadingServers } = useServers();
  const servers = serversData?.data?.servers || [];

  const [isOverlayOpen, setOverlayOpen] = useState(false);
  const [isGroupPanelOpen, setIsGroupPanelOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Partial<Agent> | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<UUID | null>(null);

  const openOverlay = (agent: Partial<Agent>) => {
    setSelectedAgent(agent);
    setOverlayOpen(true);
  };

  const closeOverlay = () => {
    setSelectedAgent(null);
    setOverlayOpen(false);
  };

  const handleNavigateToDm = async (agent: Agent) => {
    if (!agent.id) return;
    // Navigate directly to agent chat - DM channel will be created automatically with default server
    navigate(`/chat/${agent.id}`);
  };

  const handleCreateGroup = () => {
    navigate('/group/new');
  };

  useEffect(() => {
    clientLogger.info('[Home] Component mounted/re-rendered. Key might have changed.');
    // You might want to trigger data re-fetching here if it's not automatic
    // e.g., queryClient.invalidateQueries(['agents']);
  }, []); // Empty dependency array means this runs on mount and when key changes

  return (
    <>
      <div className="flex-1 p-3 w-full h-full">
        <div className="flex flex-col gap-4 h-full w-full md:max-w-4xl mx-auto">
          <div className="flex items-center justify-between gap-2 p-2">
            <PageTitle title="Agents" />
            <Button
              variant="outline"
              onClick={() => navigate('/create')}
              className="create-agent-button"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <Separator />

          {isLoading && <div className="text-center py-8">Loading agents...</div>}

          {isError && (
            <div className="text-center py-8">
              Error loading agents: {error instanceof Error ? error.message : 'Unknown error'}
            </div>
          )}

          {agents.length === 0 && !isLoading && (
            <div className="text-center py-8 flex flex-col items-center gap-4">
              <p className="text-muted-foreground">
                No agents currently running. Start a character to begin.
              </p>
            </div>
          )}

          {!isLoading && !isError && (
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-2 auto-rows-fr agents-section">
              <AddAgentCard />
              {agents
                .sort((a, b) => Number(b?.enabled) - Number(a?.enabled))
                .map((agent) => {
                  return (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      onChat={() => handleNavigateToDm(agent)}
                    />
                  );
                })}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 p-2">
            <PageTitle title="Groups" />
            <Button variant="outline" onClick={handleCreateGroup} className="groups-create-button">
              <Plus className="w-2 h-2" />
            </Button>
          </div>
          <Separator />

          {!isLoading && !isError && (
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-2 auto-rows-fr groups-section">
              {servers.map((server) => (
                <ServerChannels key={server.id} serverId={server.id} />
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedAgent?.id && (
        <ProfileOverlay isOpen={isOverlayOpen} onClose={closeOverlay} agentId={selectedAgent.id} />
      )}

      {isGroupPanelOpen && (
        <GroupPanel
          agents={agents as Agent[]}
          onClose={() => {
            setSelectedGroupId(null);
            setIsGroupPanelOpen(false);
          }}
          channelId={selectedGroupId ?? undefined}
        />
      )}
    </>
  );
}

// Sub-component to fetch and display channels for a given server
const ServerChannels = ({ serverId }: { serverId: UUID }) => {
  const { data: channelsData, isLoading: isLoadingChannels } = useChannels(serverId);
  const groupChannels = useMemo(
    () => channelsData?.data?.channels?.filter((ch) => ch.type === CoreChannelType.GROUP) || [],
    [channelsData]
  );

  if (isLoadingChannels) return <p>Loading channels for server...</p>;
  if (!groupChannels || groupChannels.length === 0)
    return <p className="text-sm text-muted-foreground">No group channels in this server.</p>;

  return (
    <>
      {groupChannels.map((channel) => (
        <GroupCard
          key={channel.id}
          group={{ ...channel, server_id: serverId }} // Pass server_id for navigation context
        />
      ))}
    </>
  );
};
