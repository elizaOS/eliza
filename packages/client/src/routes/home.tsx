import AddAgentCard from '@/components/add-agent-card';
import AgentCard from '@/components/agent-card';
import GroupCard from '@/components/group-card';
import GroupPanel from '@/components/group-panel';
import ProfileOverlay from '@/components/profile-overlay';
import { useAgentsWithDetails, useChannels, useServers } from '@/hooks/use-query-hooks';
import clientLogger from '@/lib/logger';
import { type Agent, type UUID, ChannelType as CoreChannelType, AgentStatus } from '@elizaos/core';
import type { MessageChannel, MessageServer } from '@/types';
import { Plus } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

/**
 * Renders the main dashboard for managing agents and groups, providing interactive controls for viewing, starting, messaging, and configuring agents, as well as creating and editing groups.
 *
 * Displays lists of agents and groups with status indicators, action buttons, and overlays for detailed views and settings. Handles loading and error states, and supports navigation to chat and settings pages.
 */
export default function Home() {
  const { data: agentsData, isLoading, isError, error } = useAgentsWithDetails();
  const navigate = useNavigate();

  // Extract agents properly from the response
  const agents = useMemo(() => agentsData?.agents || [], [agentsData]);
  const activeAgentsCount = agents.filter((a) => a.status === AgentStatus.ACTIVE).length;

  const { data: serversData } = useServers() as {
    data: { data: { servers: MessageServer[] } } | undefined;
  };
  const servers = serversData?.data?.servers || [];

  const [isOverlayOpen, setOverlayOpen] = useState(false);
  const [isGroupPanelOpen, setIsGroupPanelOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Partial<Agent> | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<UUID | null>(null);
  const [activeTab, setActiveTab] = useState('agents');

  const closeOverlay = () => {
    setSelectedAgent(null);
    setOverlayOpen(false);
  };

  const handleNavigateToDm = async (agent: Partial<Agent>) => {
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
      <div className="flex-1 w-full overflow-y-auto bg-background">
        <div className="flex flex-col w-full h-full">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="w-full h-full flex flex-col"
          >
            <div className="w-full">
              <div className="w-full md:max-w-4xl mx-auto px-6 py-6">
                <TabsList className="h-auto p-0 bg-transparent border-0 border-b-0 gap-2 w-auto">
                  <TabsTrigger
                    value="agents"
                    className="relative rounded-full px-7 py-3 text-base font-semibold transition-colors duration-150 border-0 border-b-0 data-[state=active]:bg-white data-[state=active]:text-black data-[state=active]:shadow-md data-[state=active]:border-b-0 data-[state=inactive]:text-muted-foreground data-[state=inactive]:bg-transparent hover:text-foreground/80 hover:bg-white/50 hover:border-b-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                  >
                    Agents
                    {activeAgentsCount > 0 && (
                      <span className="ml-2.5 inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#0B35F1] text-white text-xs font-semibold">
                        {activeAgentsCount}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger
                    value="groups"
                    className="relative rounded-full px-7 py-3 text-base font-semibold transition-colors duration-150 border-0 border-b-0 data-[state=active]:bg-white data-[state=active]:text-black data-[state=active]:shadow-md data-[state=active]:border-b-0 data-[state=inactive]:text-muted-foreground data-[state=inactive]:bg-transparent hover:text-foreground/80 hover:bg-white/50 hover:border-b-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                  >
                    Groups
                  </TabsTrigger>
                </TabsList>
              </div>
            </div>

            <TabsContent value="agents" className="flex-1 mt-0 bg-background">
              <div className="flex flex-col gap-6 w-full md:max-w-4xl mx-auto px-6 py-8">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xl font-semibold">Your Agents</h2>
                  <Button
                    variant="outline"
                    onClick={() => navigate('/create')}
                    className="create-agent-button"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>

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
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-2 gap-3 agents-section">
                    {agents
                      .sort((a, b) => {
                        // Sort by status - ACTIVE agents first
                        const aActive = a.status === AgentStatus.ACTIVE ? 1 : 0;
                        const bActive = b.status === AgentStatus.ACTIVE ? 1 : 0;
                        return bActive - aActive;
                      })
                      .map((agent) => {
                        return (
                          <AgentCard
                            key={agent.id}
                            agent={agent}
                            onChat={() => handleNavigateToDm(agent as Agent)}
                          />
                        );
                      })}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="groups" className="flex-1 mt-0 bg-background">
              <div className="flex flex-col gap-6 w-full md:max-w-4xl mx-auto px-6 py-8">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xl font-semibold">Your Groups</h2>
                  <Button
                    variant="outline"
                    onClick={handleCreateGroup}
                    className="groups-create-button"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>

                {!isLoading && !isError && (
                  <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-fr groups-section">
                    {servers.map((server: MessageServer) => (
                      <ServerChannels key={server.id} serverId={server.id} />
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {selectedAgent?.id && (
        <ProfileOverlay isOpen={isOverlayOpen} onClose={closeOverlay} agentId={selectedAgent.id} />
      )}

      {isGroupPanelOpen && (
        <GroupPanel
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
const ServerChannels = React.memo(({ serverId }: { serverId: UUID }) => {
  const { data: channelsData, isLoading: isLoadingChannels } = useChannels(serverId) as {
    data: { data: { channels: MessageChannel[] } } | undefined;
    isLoading: boolean;
  };
  const groupChannels = useMemo(
    () =>
      channelsData?.data?.channels?.filter(
        (ch: MessageChannel) => ch.type === CoreChannelType.GROUP
      ) || [],
    [channelsData]
  );

  if (isLoadingChannels) return <p>Loading channels for server...</p>;
  if (!groupChannels || groupChannels.length === 0)
    return <p className="text-sm text-muted-foreground">No group channels in this server.</p>;

  return (
    <>
      {groupChannels.map((channel: MessageChannel) => (
        <GroupCard
          key={channel.id}
          group={{ ...channel, server_id: serverId } as MessageChannel & { server_id: UUID }} // Pass server_id for navigation context
        />
      ))}
    </>
  );
});

ServerChannels.displayName = 'ServerChannels';
