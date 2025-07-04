import ConfirmationDialog from '@/components/confirmation-dialog';
import ConnectionStatus from '@/components/connection-status';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { useConfirmation } from '@/hooks/use-confirmation';

import {
  useAgentsWithDetails,
  useChannelParticipants, // New hook
  useChannels,
  useServers, // New hook
} from '@/hooks/use-query-hooks';
import { useServerVersionString } from '@/hooks/use-server-version';
import { cn, formatAgentName, generateGroupName, getAgentAvatar, getEntityId } from '@/lib/utils';
import type {
  MessageChannel as ClientMessageChannel,
  MessageServer as ClientMessageServer,
} from '@/types';
import {
  AgentStatus as CoreAgentStatus,
  ChannelType as CoreChannelType,
  type Agent,
  type UUID,
} from '@elizaos/core';

import { useDeleteChannel } from '@/hooks/use-query-hooks';
import clientLogger from '@/lib/logger'; // Added import
import { useQueryClient } from '@tanstack/react-query'; // Import useQueryClient
import { Book, Cog, Plus, TerminalIcon, Trash2 } from 'lucide-react'; // Added Hash for channels
import { useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom'; // Added useNavigate
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Separator } from './ui/separator';

/* ---------- helpers ---------- */
const partition = <T,>(src: T[], pred: (v: T) => boolean): [T[], T[]] => {
  const pass: T[] = [];
  const fail: T[] = [];
  src.forEach((v) => (pred(v) ? pass : fail).push(v));
  return [pass, fail];
};

/* ---------- tiny components ---------- */
const SectionHeader = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      'px-4 pt-1 pb-0 text-sm font-medium text-muted-foreground sidebar-section-header',
      className
    )}
  >
    {children}
  </div>
);

const SidebarSection = ({
  title,
  children,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) => (
  <>
    <SectionHeader className={className}>{title}</SectionHeader>
    <SidebarGroup>
      <SidebarGroupContent className="mt-0">
        <SidebarMenu>{children}</SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </>
);

const AgentRow = ({
  agent,
  isOnline,
  active,
}: {
  agent: Agent;
  isOnline: boolean;
  active: boolean;
}) => (
  <SidebarMenuItem>
    <NavLink to={`/chat/${agent.id}`}>
      <SidebarMenuButton
        isActive={active}
        className="px-2 py-2 my-1 h-full rounded justify-between cursor-pointer"
      >
        <span className="text-base truncate max-w-36">{agent.name}</span>
        <div className="flex items-center">
          <div className="relative">
            <Avatar className="h-6 w-6 rounded-full">
              <AvatarImage src={getAgentAvatar(agent)} alt={agent.name || 'avatar'} />
              <AvatarFallback className="rounded-full">
                {formatAgentName(agent.name || '')}
              </AvatarFallback>
            </Avatar>
            <span
              className={cn(
                'absolute bottom-0 right-0 w-[8px] h-[8px] rounded border border-white',
                isOnline ? 'bg-green-500' : 'bg-muted-foreground'
              )}
            />
          </div>
        </div>
      </SidebarMenuButton>
    </NavLink>
  </SidebarMenuItem>
);

const GroupRow = ({
  channel,
  serverId,
  active,
}: {
  channel: ClientMessageChannel;
  serverId: UUID;
  active: boolean;
}) => {
  const currentClientId = getEntityId();

  const { data: agentsData } = useAgentsWithDetails();
  const allAgents = agentsData?.agents || [];

  const { data: participantsData } = useChannelParticipants(channel.id as UUID);
  const participants = participantsData?.data;
  const participantsIds: UUID[] = participants && Array.isArray(participants) ? participants : [];
  const groupAgents = allAgents.filter((agent) => agent.id && participantsIds.includes(agent.id));

  const displayedAgents = groupAgents.slice(0, 3);
  const extraCount = groupAgents.length > 3 ? groupAgents.length - 3 : 0;

  return (
    <SidebarMenuItem>
      <NavLink to={`/group/${channel.id}?serverId=${serverId}`} className="flex-1">
        <SidebarMenuButton
          isActive={active}
          className="px-2 py-2 my-1 h-full rounded justify-between cursor-pointer"
        >
          {/* Name */}
          <span className="text-base truncate max-w-36">
            {channel.name ||
              generateGroupName(channel, (channel as any).participants || [], currentClientId)}
          </span>
          <div className="flex items-center gap-2">
            {/* Avatars */}
            <div className="flex -space-x-2">
              {displayedAgents.map((agent) => (
                <Avatar key={agent.id} className="h-6 w-6 rounded-full border border-background">
                  <AvatarImage
                    src={typeof agent.settings?.avatar === 'string' ? agent.settings.avatar : ''}
                    alt={agent.name || ''}
                  />
                  <AvatarFallback className="rounded-full text-xs">
                    {formatAgentName(agent.name || '')}
                  </AvatarFallback>
                </Avatar>
              ))}
              {extraCount > 0 && (
                <div className="w-6 h-6 rounded-full bg-muted text-[10px] flex items-center justify-center border border-background">
                  +{extraCount}
                </div>
              )}
            </div>
          </div>
        </SidebarMenuButton>
      </NavLink>
    </SidebarMenuItem>
  );
};

const AgentListSection = ({
  agents,
  activePath,
}: {
  agents: Partial<Agent>[];
  activePath: string;
}) => (
  <>
    <div className="flex items-center px-4 pt-1 pb-0 text-muted-foreground">
      <SectionHeader className="px-0 py-0 text-xs flex gap-1 mr-2">
        <div>Agents</div>
      </SectionHeader>
      <Separator />
    </div>
    <SidebarGroup>
      <SidebarGroupContent className="px-1 mt-0">
        <SidebarMenu>
          {agents.map((a) => (
            <AgentRow
              key={a?.id}
              agent={a as Agent}
              isOnline={a.status === CoreAgentStatus.ACTIVE}
              active={activePath.includes(`/chat/${String(a?.id)}`)}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </>
);

const GroupListSection = ({
  servers,
  isLoadingServers,
  activePath,
}: {
  servers: ClientMessageServer[] | undefined;
  isLoadingServers: boolean;
  activePath: string;
}) => {
  return (
    <>
      <div className="flex items-center px-4 pt-1 pb-0 text-muted-foreground">
        <SectionHeader className="px-0 py-0 text-xs flex gap-1 mr-2">
          <div>Groups</div>
        </SectionHeader>
        <Separator />
      </div>
      <SidebarGroup>
        <SidebarGroupContent className="px-1 mt-0">
          <SidebarMenu>
            {isLoadingServers &&
              Array.from({ length: 3 }).map((_, i) => (
                <SidebarMenuItem key={`skel-group-${i}`}>
                  <SidebarMenuSkeleton />
                </SidebarMenuItem>
              ))}
            {servers?.map((server) => (
              <GroupChannelsForServer
                key={server.id}
                serverId={server.id}
                activePath={activePath}
              />
            ))}
            {(!servers || servers.length === 0) && !isLoadingServers && (
              <SidebarMenuItem>
                <div className="p-4 text-xs text-muted-foreground">No groups found.</div>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
};

// Updated RoomListSection to GroupChannelListSection
const GroupChannelListSection = ({
  servers,
  isLoadingServers,
  className = '',
  onManageServers,
}: {
  servers: ClientMessageServer[] | undefined;
  isLoadingServers: boolean;
  className?: string;
  onManageServers: () => void;
}) => {
  const navigate = useNavigate();

  return (
    <SidebarSection title="Groups" className={className}>
      {isLoadingServers &&
        Array.from({ length: 3 }).map((_, i) => (
          <SidebarMenuItem key={`skel-server-${i}`}>
            <SidebarMenuSkeleton />
          </SidebarMenuItem>
        ))}
      {servers?.map((server) => (
        <SidebarGroup key={server.id} className="mt-1">
          {/* Optionally display server name if relevant, or just list all groups flatly */}
          {/* <div className="px-3 py-1 text-xs text-muted-foreground">{server.name}</div> */}
          <ChannelsForServer serverId={server.id} navigate={navigate} />
        </SidebarGroup>
      ))}
      {(!servers || servers.length === 0) && !isLoadingServers && (
        <SidebarMenuItem>
          <div className="p-4 text-xs text-muted-foreground">No groups found.</div>
        </SidebarMenuItem>
      )}
      <div className="flex justify-endtop-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/group/new')}
          className="text-xs"
        >
          <Plus className="h-3 w-3 mr-1" /> New Group
        </Button>
      </div>
    </SidebarSection>
  );
};

const ChannelsForServer = ({
  serverId,
  navigate,
}: {
  serverId: UUID;
  navigate: ReturnType<typeof useNavigate>;
}) => {
  const { data: channelsData, isLoading: isLoadingChannels } = useChannels(serverId);
  const currentClientId = getEntityId(); // Get current client/user ID
  const deleteChannelMutation = useDeleteChannel();
  const [deletingChannelId, setDeletingChannelId] = useState<UUID | null>(null);
  const { confirm, isOpen, onOpenChange, onConfirm, options } = useConfirmation();

  const groupChannels = useMemo(
    () => channelsData?.data?.channels?.filter((ch) => ch.type === CoreChannelType.GROUP) || [],
    [channelsData]
  );

  const handleDeleteChannel = (e: React.MouseEvent, channelId: UUID) => {
    e.preventDefault();
    e.stopPropagation();

    confirm(
      {
        title: 'Delete Group',
        description: 'Are you sure you want to delete this group? This action cannot be undone.',
        confirmText: 'Delete',
        variant: 'destructive',
      },
      async () => {
        setDeletingChannelId(channelId);
        try {
          await deleteChannelMutation.mutateAsync({ channelId, serverId });
        } catch (error) {
          console.error('Failed to delete channel:', error);
        } finally {
          setDeletingChannelId(null);
        }
      }
    );
  };

  if (isLoadingChannels) {
    return (
      <SidebarMenuItem>
        <SidebarMenuSkeleton />
      </SidebarMenuItem>
    );
  }
  if (!groupChannels.length) {
    return null; // Don't render section if no group channels for this server
  }

  return (
    <>
      <SidebarGroupContent className="px-1 mt-0">
        <SidebarMenu>
          {groupChannels.map((channel) => (
            <SidebarMenuItem key={channel.id} className="h-12 group">
              <div className="flex items-center gap-1 w-full">
                <NavLink to={`/group/${channel.id}?serverId=${serverId}`} className="flex-1">
                  <SidebarMenuButton className="px-4 py-2 my-1 h-full rounded cursor-pointer">
                    <div className="flex items-center gap-3">
                      <Users className="h-5 w-5 text-muted-foreground" /> {/* Group icon */}
                      <span className="text-sm truncate max-w-32">
                        {/* Use generateGroupName - assumes channel.participants exists or will be added */}
                        {generateGroupName(
                          channel,
                          (channel as any).participants || [],
                          currentClientId
                        )}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </NavLink>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => handleDeleteChannel(e, channel.id)}
                  disabled={deletingChannelId === channel.id}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>

      {/* Confirmation Dialog */}
      <ConfirmationDialog
        open={isOpen}
        onOpenChange={onOpenChange}
        title={options?.title || ''}
        description={options?.description || ''}
        confirmText={options?.confirmText}
        cancelText={options?.cancelText}
        variant={options?.variant}
        onConfirm={onConfirm}
      />
    </>
  );
};

const GroupChannelsForServer = ({
  serverId,
  activePath,
}: {
  serverId: UUID;
  activePath: string;
}) => {
  const { data: channelsData, isLoading: isLoadingChannels } = useChannels(serverId);

  const groupChannels = useMemo(
    () => channelsData?.data?.channels?.filter((ch) => ch.type === CoreChannelType.GROUP) || [],
    [channelsData]
  );

  if (isLoadingChannels) {
    return (
      <SidebarMenuItem>
        <SidebarMenuSkeleton />
      </SidebarMenuItem>
    );
  }

  if (!groupChannels.length) {
    return null; // Don't render if no group channels for this server
  }

  return (
    <>
      {groupChannels.map((channel) => (
        <GroupRow
          key={channel.id}
          channel={channel}
          serverId={serverId}
          active={activePath.includes(`/group/${channel.id}`)}
        />
      ))}
    </>
  );
};

// Updated CreateButton: Removed DropdownMenu, simplified to a single action (Create Agent)
// For "Create Group", users will use the button in the "Groups" section header.
const CreateAgentButton = ({ onClick }: { onClick: () => void }) => {
  return (
    <Button variant="outline" size="sm" onClick={onClick} className="w-full">
      <Plus className="h-4 w-4 mr-2" />
      Create Agent
    </Button>
  );
};

interface AppSidebarProps {
  refreshHomePage: () => void;
}

/**
 * Renders the main application sidebar, displaying navigation, agent lists, group rooms, and utility links.
 *
 * The sidebar includes sections for online and offline agents, group rooms, a create button for agents and groups, and footer links to documentation, logs, and settings. It handles loading and error states for agent and room data, and conditionally displays a group creation panel.
 */
export function AppSidebar({
  refreshHomePage,
  isMobile = false,
}: AppSidebarProps & { isMobile?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient(); // Get query client instance
  const version = useServerVersionString(); // Get server version

  const {
    data: agentsData,
    error: agentsError,
    isLoading: isLoadingAgents,
  } = useAgentsWithDetails();
  const { data: serversData, isLoading: isLoadingServers } = useServers();

  const agents = useMemo(() => agentsData?.agents || [], [agentsData]);
  const servers = useMemo(() => serversData?.data?.servers || [], [serversData]);

  const [onlineAgents, offlineAgents] = useMemo(
    () => partition(agents, (a) => a.status === CoreAgentStatus.ACTIVE),
    [agents]
  );

  const agentLoadError = agentsError
    ? 'Error loading agents: NetworkError: Unable to connect to the server. Please check if the server is running.'
    : undefined;

  const handleLogoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    clientLogger.info('[AppSidebar] handleLogoClick triggered', { currentPath: location.pathname });

    // Invalidate queries that should be fresh on home page
    queryClient.invalidateQueries({ queryKey: ['agents'] });
    queryClient.invalidateQueries({ queryKey: ['agentsWithDetails'] }); // if this is a separate key
    queryClient.invalidateQueries({ queryKey: ['servers'] });
    queryClient.invalidateQueries({ queryKey: ['channels'] }); // This is broad, consider more specific invalidations if performance is an issue
    // Example: if you know active server IDs, invalidate ['channels', serverId]

    if (location.pathname === '/') {
      clientLogger.info('[AppSidebar] Already on home page. Calling refreshHomePage().');
      // refreshHomePage should ideally trigger a re-render/refetch in Home.tsx
      // This can be done by changing a key prop on Home.tsx or further query invalidations if needed.
      refreshHomePage();
    } else {
      clientLogger.info('[AppSidebar] Not on home page. Navigating to "/".');
      navigate('/');
    }
  };

  function renderCreateNewButton() {
    const navigate = useNavigate();

    const handleCreateAgent = () => {
      navigate('/create');
    };

    const handleCreateGroup = () => {
      navigate('/group/new');
    };

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="w-full bg-sidebar-accent hover:bg-sidebar-accent/80 h-10 rounded justify-start"
          >
            <Plus className="w-4 h-4 bg" />
            Create New
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-full min-w-[var(--radix-dropdown-menu-trigger-width)]"
        >
          <DropdownMenuItem onClick={handleCreateAgent} className="w-full">
            Create New Agent
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleCreateGroup} className="w-full">
            Create New Group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <>
      <Sidebar
        className={cn(
          'bg-background border-r overflow-hidden',
          isMobile ? 'p-3 pt-12 w-full h-full' : 'p-4 w-72 fixed left-0 top-0 z-40 h-screen',
          !isMobile && 'hidden md:flex md:flex-col'
        )}
        collapsible="none"
        data-testid="app-sidebar"
      >
        {/* ---------- header ---------- */}
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <a
                  href="/"
                  onClick={handleLogoClick}
                  className="px-4 py-2 h-full sidebar-logo no-underline cursor-pointer"
                >
                  <div className="flex flex-col pt-2 gap-1 items-start justify-center">
                    <img
                      alt="elizaos-logo"
                      src="/elizaos-logo-light.png"
                      className="w-32 max-w-full"
                    />
                    <span className="text-xs font-mono text-muted-foreground">v{version}</span>
                  </div>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        {/* ---------- content ---------- */}
        <SidebarContent className="flex-1 overflow-y-auto">
          {/* create agent button - moved from old CreateButton dropdown */}
          {/* This section is for the "Agents" list.
              The "Create Agent" button should ideally be next to the "Agents" title.
              Let's adjust the structure slightly if needed or place it prominently.
          */}
          {agentLoadError && <div className="px-4 py-2 text-xs text-red-500">{agentLoadError}</div>}

          <SidebarMenu className="my-2">
            <SidebarMenuItem className="list-none">{renderCreateNewButton()}</SidebarMenuItem>
          </SidebarMenu>

          <div className="pt-2">
            {isLoadingAgents && !agentLoadError && (
              <SidebarSection title="Agents">
                <SidebarMenuSkeleton />
              </SidebarSection>
            )}

            {!isLoadingAgents && !agentLoadError && (
              <>
                <AgentListSection
                  agents={[...onlineAgents, ...offlineAgents]}
                  activePath={location.pathname}
                />
                <GroupListSection
                  servers={servers}
                  isLoadingServers={isLoadingServers}
                  activePath={location.pathname}
                />
              </>
            )}
          </div>
        </SidebarContent>

        {/* ---------- footer ---------- */}
        <SidebarFooter className="px-2 py-4">
          <SidebarMenu>
            <FooterLink to="https://eliza.how/" Icon={Book} label="Documentation" />
            <FooterLink to="/logs" Icon={TerminalIcon} label="Logs" />
            <FooterLink to="/settings" Icon={Cog} label="Settings" />
            <ConnectionStatus />
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* Server management hidden - using single default server */}
    </>
  );
}

/* ---------- footer link ---------- */
const FooterLink = ({ to, Icon, label }: { to: string; Icon: typeof Book; label: string }) => {
  const isExternal = to.startsWith('http://') || to.startsWith('https://');

  if (isExternal) {
    return (
      <SidebarMenuItem>
        <a href={to} target="_blank" rel="noopener noreferrer">
          <SidebarMenuButton className="rounded cursor-pointer">
            <Icon className="h-4 w-4 mr-3" />
            {label}
          </SidebarMenuButton>
        </a>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <NavLink to={to}>
        <SidebarMenuButton className="rounded cursor-pointer">
          <Icon className="h-4 w-4 mr-3" />
          {label}
        </SidebarMenuButton>
      </NavLink>
    </SidebarMenuItem>
  );
};
