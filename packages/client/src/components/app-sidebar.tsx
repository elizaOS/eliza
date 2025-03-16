import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { useAgents } from '@/hooks/use-query-hooks';
import info from '@/lib/info.json';
import { formatAgentName } from '@/lib/utils';
import { type Agent, AgentStatus, ChannelType, type UUID } from '@elizaos/core';
import { Book, Cog, TerminalIcon } from 'lucide-react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import ConnectionStatus from './connection-status';
import { useState, useEffect } from 'react';
import { RoomList } from './room-list';

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: { data: agentsData } = {}, isPending: isAgentsPending } = useAgents();

  const [newRoomName, setNewRoomName] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<UUID | undefined>(undefined);

  useEffect(() => {
    // Extract agent ID from URL if present
    const match = location.pathname.match(/\/chat\/([^/?]+)/);
    if (match && match[1]) {
      setSelectedAgentId(match[1]);
    }

    // Extract room ID from URL if present
    const searchParams = new URLSearchParams(location.search);
    const roomId = searchParams.get('roomId');
    if (roomId) {
      setSelectedRoomId(roomId as UUID);
    }
  }, [location]);

  // Function to fetch rooms - this needs to be implemented based on your app structure
  const fetchRooms = async () => {
    // Implementation would go here
    console.log('Fetching rooms...');
  };

  const handleCreateRoom = async () => {
    if (!newRoomName.trim() || !selectedAgentId) return;

    try {
      console.log(`Creating room with agent ID: ${selectedAgentId}`);

      // Use relative path instead of hardcoded localhost URL
      const response = await fetch(`/agents/${selectedAgentId}/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: newRoomName,
          type: ChannelType.GROUP,
          entityId: '10000000-0000-0000-0000-000000000000', // Fixed user ID
        }),
      });

      if (!response.ok) {
        console.error(`Error creating room: ${response.status} ${response.statusText}`);
        const text = await response.text();
        console.error(`Response body: ${text}`);
        return;
      }

      const data = await response.json();

      if (data.success) {
        setIsCreateDialogOpen(false);
        setNewRoomName('');

        // Navigate to the new room
        const newRoomId = data.data.id;
        console.log(`Created room with ID: ${newRoomId}, navigating to it`);

        // Navigate to the chat page with the new room
        navigate(`/chat/${selectedAgentId}?roomId=${newRoomId}`);
      }
    } catch (error) {
      console.error('Error creating room:', error);
    }
  };

  const handleSelectRoom = (roomId: UUID) => {
    if (!selectedAgentId) return;

    setSelectedRoomId(roomId);
    navigate(`/chat/${selectedAgentId}?roomId=${roomId}`);
  };

  return (
    <Sidebar className="bg-background">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/" className="px-6 py-2 h-full">
                <div className="flex flex-col pt-2 gap-1 items-start justify-center">
                  <img alt="elizaos-logo" src="/elizaos-logo-light.png" width="90%" />
                  <span className="text-xs font-mono text-muted-foreground text-center">
                    v{info?.version}
                  </span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent className="px-2">
            <SidebarMenu>
              {isAgentsPending ? (
                <div>
                  {Array.from({ length: 5 }).map((_, index) => (
                    <SidebarMenuItem key={`skeleton-item-${index}`}>
                      <SidebarMenuSkeleton />
                    </SidebarMenuItem>
                  ))}
                </div>
              ) : (
                <div>
                  {(() => {
                    // Sort agents: enabled first, then disabled
                    const sortedAgents = [...(agentsData?.agents || [])].sort((a, b) => {
                      // Sort by status (active agents first)
                      if (a.status === AgentStatus.ACTIVE && b.status !== AgentStatus.ACTIVE)
                        return -1;
                      if (a.status !== AgentStatus.ACTIVE && b.status === AgentStatus.ACTIVE)
                        return 1;
                      // If both have the same status, sort alphabetically by name
                      return a.name.localeCompare(b.name);
                    });

                    // Split into enabled and disabled groups
                    const activeAgents = sortedAgents.filter(
                      (agent: Partial<Agent & { status: string }>) =>
                        agent.status === AgentStatus.ACTIVE
                    );
                    const inactiveAgents = sortedAgents.filter(
                      (agent: Partial<Agent & { status: string }>) =>
                        agent.status === AgentStatus.INACTIVE
                    );

                    return (
                      <>
                        {/* Render active section */}
                        {activeAgents.length > 0 && (
                          <div className="px-4 py-1">
                            <div className="flex items-center space-x-2">
                              <span className="text-sm font-medium text-muted-foreground">
                                Online
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Render enabled agents */}
                        {activeAgents.map((agent) => (
                          <SidebarMenuItem key={agent.id}>
                            <NavLink to={`/chat/${agent.id}`}>
                              <SidebarMenuButton
                                isActive={location.pathname.includes(agent.id as string)}
                                className="transition-colors px-4 my-4 rounded-md"
                                onClick={() => setSelectedAgentId(agent.id as string)}
                              >
                                <div className="flex items-center gap-2">
                                  <div className="w-8 h-8 flex justify-center items-center">
                                    <div className="relative bg-muted rounded-full w-full h-full">
                                      {agent && (
                                        <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                          {agent.settings?.avatar ? (
                                            <img
                                              src={agent.settings?.avatar}
                                              alt="Agent Avatar"
                                              className="w-full h-full object-contain"
                                            />
                                          ) : (
                                            formatAgentName(agent.name)
                                          )}
                                          <div
                                            className={`absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-[1px] border-white bg-green-500`}
                                          />
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <span className="text-base">{agent.name}</span>
                                </div>
                              </SidebarMenuButton>
                            </NavLink>
                          </SidebarMenuItem>
                        ))}

                        {/* Render inactive section */}
                        {inactiveAgents.length > 0 && (
                          <div className="px-4 py-1 mt-8">
                            <div className="flex items-center space-x-2">
                              <span className="text-sm font-medium text-muted-foreground">
                                Offline
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Render disabled agents */}
                        {inactiveAgents.map((agent) => (
                          <SidebarMenuItem key={agent.id}>
                            <div className="transition-colors px-4 my-4 rounded-md">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 flex justify-center items-center">
                                  <div className="relative bg-muted rounded-full w-full h-full">
                                    {agent && (
                                      <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                        {agent.settings?.avatar ? (
                                          <img
                                            src={agent.settings.avatar}
                                            alt="Agent Avatar"
                                            className="w-full h-full object-contain"
                                          />
                                        ) : (
                                          formatAgentName(agent.name)
                                        )}
                                        <div
                                          className={`absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-[1px] border-white bg-muted-foreground`}
                                        />
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <span className="text-base truncate max-w-24">{agent.name}</span>
                              </div>
                            </div>
                          </SidebarMenuItem>
                        ))}
                      </>
                    );
                  })()}
                </div>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Room List section - display only when an agent is selected */}
        {selectedAgentId && (
          <SidebarGroup>
            <SidebarGroupLabel>Rooms</SidebarGroupLabel>
            <SidebarGroupContent className="px-2">
              <RoomList
                agentId={selectedAgentId as UUID}
                selectedRoomId={selectedRoomId}
                onSelectRoom={handleSelectRoom}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="px-4 py-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <NavLink to="https://elizaos.github.io/eliza/docs/intro/" target="_blank">
              <SidebarMenuButton className="text-muted-foreground rounded-md">
                <Book className="size-5" />
                <span>Documentation</span>
              </SidebarMenuButton>
            </NavLink>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <NavLink to="/logs">
              <SidebarMenuButton className="text-muted-foreground rounded-md">
                <TerminalIcon className="size-5" />
                <span>Logs</span>
              </SidebarMenuButton>
            </NavLink>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton disabled className="text-muted-foreground/50 rounded-md">
              <Cog className="size-5" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <ConnectionStatus />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
