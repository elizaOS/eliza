import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAgentPanels, type AgentPanel } from '@/hooks/use-query-hooks';
import { useElizaAgent } from '@/hooks/use-eliza';
import type { UUID } from '@elizaos/core';
import { Columns3, Database, Eye, Code, InfoIcon, Loader2, Activity } from 'lucide-react';
import { JSX, useMemo } from 'react';
import { AgentActionViewer } from './agent-action-viewer';
import { AgentLogViewer } from './agent-log-viewer';
import { AgentMemoryViewer } from './agent-memory-viewer';
import { Skeleton } from './ui/skeleton';
import AgentSettings from '@/components/agent-settings';
import { useAgentTabState } from '@/hooks/use-agent-tab-state';
import AgentRunTimeline from '@/components/agent-runs/AgentRunTimeline';

type AgentSidebarProps = {
  agentId: UUID | undefined;
  agentName: string;
  channelId?: UUID;
};

type FixedTabValue = 'details' | 'timeline' | 'actions' | 'logs' | 'memories';
type TabValue = FixedTabValue | string;

export function AgentSidebar({ agentId, agentName, channelId }: AgentSidebarProps) {
  const { currentTab: detailsTab, setTab: setDetailsTab } = useAgentTabState(agentId);
  const { data: panelsResponse, isLoading: isLoadingPanels } = useAgentPanels(agentId!, {
    enabled: !!agentId,
  });

  const { agent, isLoading: isLoadingAgent, error: agentError } = useElizaAgent(agentId);

  const agentPanels = useMemo(() => {
    return panelsResponse?.data || [];
  }, [panelsResponse]);

  const allTabs: { value: TabValue; label: string; icon: JSX.Element }[] = useMemo(() => {
    const fixedTabs: { value: FixedTabValue; label: string; icon: JSX.Element }[] = [
      { value: 'details', label: 'Details', icon: <InfoIcon className="h-4 w-4" /> },
      { value: 'timeline', label: 'Timeline', icon: <Activity className="h-4 w-4" /> },
      { value: 'actions', label: 'Model Calls', icon: <Eye className="h-4 w-4" /> },
      { value: 'memories', label: 'Memories', icon: <Database className="h-4 w-4" /> },
      { value: 'logs', label: 'Logs', icon: <Code className="h-4 w-4" /> },
    ];

    const dynamicTabs = agentPanels.map((panel: AgentPanel) => ({
      value: panel.name,
      label: panel.name,
      icon: <Columns3 className="h-4 w-4" />,
    }));

    return [...fixedTabs, ...dynamicTabs];
  }, [agentPanels]);

  return (
    <Tabs
      defaultValue="details"
      value={detailsTab}
      onValueChange={setDetailsTab}
      className="flex flex-col h-screen w-full max-w-full"
    >
      <TabsList className="flex w-full max-w-full overflow-x-auto flex-shrink-0">
        {allTabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="flex items-center gap-1.5 flex-shrink-0"
          >
            {tab.icon}
            <span className="truncate">{tab.label}</span>
          </TabsTrigger>
        ))}
        {isLoadingPanels && (
          <>
            {[...Array(2)].map((_, i) => (
              <Skeleton key={`skel-tab-${i}`} className="h-9 w-full rounded-md flex-shrink-0" />
            ))}
          </>
        )}
      </TabsList>

      <TabsContent
        value="details"
        className="overflow-y-auto overflow-x-hidden flex-1 p-4 w-full max-w-full min-h-0"
      >
        {detailsTab === 'details' && agentId && (
          <>
            {isLoadingAgent && (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}
            {agentError && (
              <div className="text-red-500 break-words">
                Error loading agent details: {agentError.message}
              </div>
            )}
            {!isLoadingAgent && !agentError && agent && (
              <div className="w-full max-w-full">
                <AgentSettings
                  agent={agent}
                  agentId={agentId}
                  onSaveComplete={() => {
                    // Stay on the same page after save in sidebar context
                    // Agent settings saved from sidebar
                  }}
                />
              </div>
            )}
            {!isLoadingAgent && !agentError && !agent && !isLoadingPanels && (
              <div className="text-muted-foreground">Agent details not found.</div>
            )}
          </>
        )}
        {detailsTab === 'details' && !agentId && (
          <div className="p-4 text-muted-foreground">Select an agent to see their details.</div>
        )}
      </TabsContent>

      <TabsContent
        value="timeline"
        className="overflow-y-auto overflow-x-hidden flex-1 w-full max-w-full min-h-0 p-0"
      >
        {detailsTab === 'timeline' && agentId && (
          <div className="w-full max-w-full h-full">
            <AgentRunTimeline agentId={agentId} />
          </div>
        )}
        {detailsTab === 'timeline' && !agentId && (
          <div className="p-4 text-muted-foreground">Select an agent to see run activity.</div>
        )}
      </TabsContent>

      <TabsContent
        value="actions"
        className="overflow-y-auto overflow-x-hidden flex-1 w-full max-w-full min-h-0"
      >
        {detailsTab === 'actions' && agentId && (
          <div className="w-full max-w-full">
            <AgentActionViewer agentId={agentId} />
          </div>
        )}
        {detailsTab === 'actions' && !agentId && (
          <div className="p-4 text-muted-foreground">Select an agent to see their actions.</div>
        )}
      </TabsContent>
      <TabsContent
        value="logs"
        className="overflow-y-auto overflow-x-hidden flex-1 w-full max-w-full min-h-0"
      >
        {detailsTab === 'logs' && agentId && (
          <div className="w-full max-w-full">
            <AgentLogViewer agentName={agentName} level="all" />
          </div>
        )}
        {detailsTab === 'logs' && !agentId && (
          <div className="p-4 text-muted-foreground">Select an agent to see their logs.</div>
        )}
      </TabsContent>
      <TabsContent
        value="memories"
        className="overflow-y-auto overflow-x-hidden flex-1 w-full max-w-full min-h-0"
      >
        {detailsTab === 'memories' && agentId && (
          <div className="w-full max-w-full">
            <AgentMemoryViewer agentId={agentId} agentName={agentName} channelId={channelId} />
          </div>
        )}
        {detailsTab === 'memories' && !agentId && (
          <div className="p-4 text-muted-foreground">Select an agent to see their memories.</div>
        )}
      </TabsContent>
      {agentPanels.map((panel: AgentPanel) => (
        <TabsContent
          key={panel.name}
          value={panel.name}
          className="overflow-y-auto overflow-x-hidden flex-1 w-full max-w-full min-h-0"
        >
          {detailsTab === panel.name && agentId && (
            <iframe
              src={panel.url}
              title={panel.name}
              className="w-full h-full border-0 flex-1 max-w-full"
            />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}
