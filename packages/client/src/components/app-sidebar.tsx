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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import GroupPanel from '@/components/group-panel';
import ConnectionStatus from '@/components/connection-status';
import AgentAvatarStack from '@/components/agent-avatar-stack';

import { useAgents, useRooms } from '@/hooks/use-query-hooks';
import info from '@/lib/info.json';
import { formatAgentName, cn } from '@/lib/utils';
import { AgentStatus, type UUID, type Agent } from '@elizaos/core';

import { Book, ChevronDown, Cog, Plus, TerminalIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router';

/* ---------- helpers ---------- */
const partition = <T,>(src: T[], pred: (v: T) => boolean): [T[], T[]] => {
  const pass: T[] = [];
  const fail: T[] = [];
  src.forEach((v) => (pred(v) ? pass : fail).push(v));
  return [pass, fail];
};

const getRoomAgentIds = (
  roomsData: ReturnType<typeof useRooms>['data'],
  roomId: string | null
): UUID[] =>
  roomId ? ((roomsData?.get(roomId) ?? []).map((r) => r.agentId).filter(Boolean) as UUID[]) : [];

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
      <SidebarGroupContent className="px-1 mt-0">
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
  <SidebarMenuItem className="h-16">
    <NavLink to={`/chat/${agent.id}`}>
      <SidebarMenuButton isActive={active} className="px-4 py-2 my-2 h-full rounded-md">
        <div className="flex items-center gap-2">
          <div className="relative w-8 h-8 rounded-full bg-gray-600">
            {agent.settings?.avatar ? (
              <img
                src={agent.settings.avatar}
                alt="avatar"
                className="object-cover w-full h-full rounded-full"
              />
            ) : (
              <span className="flex items-center justify-center w-full h-full text-sm">
                {formatAgentName(agent.name)}
              </span>
            )}
            <span
              className={cn(
                'absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border border-white',
                isOnline ? 'bg-green-500' : 'bg-muted-foreground'
              )}
            />
          </div>
          <span className="text-base truncate max-w-24">{agent.name}</span>
        </div>
      </SidebarMenuButton>
    </NavLink>
  </SidebarMenuItem>
);

const AgentListSection = ({
  title,
  agents,
  isOnline,
  activePath,
  className,
}: {
  title: string;
  agents: Agent[];
  isOnline: boolean;
  activePath: string;
  className?: string;
}) => (
  <SidebarSection title={title} className={className}>
    {agents.map((a) => (
      <AgentRow
        key={a.id}
        agent={a}
        isOnline={isOnline}
        active={activePath.includes(String(a.id))}
      />
    ))}
  </SidebarSection>
);

const RoomListSection = ({
  rooms,
  roomsLoading,
  agents,
  agentAvatarMap,
}: {
  rooms: Map<string, { agentId: UUID; name: string }[]>;
  roomsLoading: boolean;
  agents: Agent[];
  agentAvatarMap: Record<string, string | null>;
}) => (
  <SidebarSection title="Groups" className="mt-2">
    {roomsLoading
      ? Array.from({ length: 5 }).map((_, i) => (
          <SidebarMenuItem key={i}>
            <SidebarMenuSkeleton />
          </SidebarMenuItem>
        ))
      : Array.from(rooms.entries()).map(([roomId, roomArr]) => {
          const roomName = roomArr[0]?.name ?? 'Unnamed';
          const ids = roomArr.map((r) => r.agentId).filter(Boolean) as UUID[];
          const names = ids.map((id) => agents.find((a) => a.id === id)?.name ?? 'Unknown');
          return (
            <SidebarMenuItem key={roomId} className="h-16">
              <NavLink to={`/room/${roomId}`}>
                <SidebarMenuButton className="px-4 py-2 my-2 h-full rounded-md">
                  <div className="flex items-center gap-5">
                    <AgentAvatarStack
                      agentIds={ids}
                      agentNames={names}
                      agentAvatars={agentAvatarMap}
                      size="md"
                      showExtraTooltip
                    />
                    <div className="flex flex-col gap-1">
                      <span className="text-base truncate max-w-24 leading-none">{roomName}</span>
                      <span className="text-xs text-muted-foreground leading-none">
                        {ids.length} {ids.length === 1 ? 'Member' : 'Members'}
                      </span>
                    </div>
                  </div>
                </SidebarMenuButton>
              </NavLink>
            </SidebarMenuItem>
          );
        })}
  </SidebarSection>
);

const CreateButton = ({ onCreateRoom }: { onCreateRoom: () => void }) => {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setAnimate(true);
      const rt = setTimeout(() => setAnimate(false), 1500);
      return () => clearTimeout(rt);
    }, 1000);
    return () => clearTimeout(t);
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          className={cn(
            'w-full justify-between items-center relative bg-primary text-primary-foreground',
            animate && 'animate-bounce-sm',
            'hover:shadow-md hover:scale-[1.02] transition-all duration-300 group'
          )}
        >
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4 group-hover:rotate-90 transition-transform duration-300" />
            Create
          </span>
          <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
          <div className="absolute inset-0 opacity-0 bg-gradient-to-r via-white/20 group-hover:opacity-100 -translate-x-full group-hover:translate-x-full transition-all duration-1000" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-48 z-50 mt-2">
        <DropdownMenuItem asChild>
          <NavLink to="/create" className="flex items-center gap-2 px-4 py-3">
            <Plus className="h-4 w-4" /> Create Agent
          </NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem className="flex items-center gap-2 px-4 py-3" onClick={onCreateRoom}>
          <Plus className="h-4 w-4" /> Create Room
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/* ---------- main component ---------- */
export function AppSidebar() {
  const { pathname } = useLocation();

  const { data: roomsData, isLoading: roomsLoading } = useRooms();
  const { data: { data: agentsResp } = {}, isError: agentsError } = useAgents();

  const agents = agentsResp?.agents ?? [];
  const isRoomPage = pathname.startsWith('/room/');
  const currentRoomId = useMemo(
    () => (isRoomPage ? pathname.split('/')[2] : null),
    [isRoomPage, pathname]
  );

  const agentAvatarMap = useMemo(
    () =>
      agents.reduce<Record<string, string | null>>((acc, a) => {
        if (a.id) acc[a.id] = a.settings?.avatar ?? null;
        return acc;
      }, {}),
    [agents]
  );

  const roomAgentIds = useMemo(
    () => getRoomAgentIds(roomsData, currentRoomId),
    [roomsData, currentRoomId]
  );

  const [onlineAgents, offlineAgents] = useMemo(() => {
    const [on, off] = partition(agents, (a) => a.status === AgentStatus.ACTIVE);
    if (!roomAgentIds.length) return [on, off];
    return [
      on.filter((a) => roomAgentIds.includes(a.id)),
      off.filter((a) => roomAgentIds.includes(a.id)),
    ];
  }, [agents, roomAgentIds]);

  const [isGroupPanelOpen, setGroupPanelOpen] = useState(false);
  const agentLoadError = agentsError
    ? 'Error loading agents: NetworkError: Unable to connect to the server. Please check if the server is running.'
    : undefined;

  return (
    <Sidebar className="bg-background">
      {/* ---------- header ---------- */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/" className="px-6 py-2 h-full sidebar-logo">
                <div className="flex flex-col pt-2 gap-1 items-start justify-center">
                  <img alt="elizaos-logo" src="/elizaos-logo-light.png" width="90%" />
                  <span className="text-xs font-mono text-muted-foreground">v{info.version}</span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* ---------- content ---------- */}
      <SidebarContent>
        {/* create */}
        <div className="px-4 py-2 mb-2">
          <CreateButton onCreateRoom={() => setGroupPanelOpen(true)} />
        </div>

        {isGroupPanelOpen && (
          <GroupPanel agents={agents} onClose={() => setGroupPanelOpen(false)} />
        )}

        {agentLoadError && <div className="px-4 py-2 text-xs text-red-500">{agentLoadError}</div>}

        {/* agent sections */}
        <AgentListSection title="Online" agents={onlineAgents} isOnline activePath={pathname} />

        {offlineAgents.length > 0 && (
          <AgentListSection
            title="Offline"
            agents={offlineAgents}
            isOnline={false}
            activePath={pathname}
            className="mt-2"
          />
        )}

        {/* room section */}
        {roomsData && (
          <RoomListSection
            rooms={roomsData}
            roomsLoading={roomsLoading}
            agents={agents}
            agentAvatarMap={agentAvatarMap}
          />
        )}
      </SidebarContent>

      {/* ---------- footer ---------- */}
      <SidebarFooter className="px-4 py-4">
        <SidebarMenu>
          <FooterLink to="https://eliza.how/" Icon={Book} label="Documentation" />
          <FooterLink to="/logs" Icon={TerminalIcon} label="Logs" />
          <FooterLink to="/settings" Icon={Cog} label="Settings" />
          <ConnectionStatus className="sidebar-connection-status" />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

/* ---------- footer link ---------- */
const FooterLink = ({ to, Icon, label }: { to: string; Icon: typeof Book; label: string }) => (
  <SidebarMenuItem>
    <NavLink to={to}>
      <SidebarMenuButton>
        <Icon className="h-4 w-4 mr-3" />
        {label}
      </SidebarMenuButton>
    </NavLink>
  </SidebarMenuItem>
);
