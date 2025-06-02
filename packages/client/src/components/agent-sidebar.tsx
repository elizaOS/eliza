import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAgentPanels, type AgentPanel } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import { Columns3, Database, Eye, Code, InfoIcon } from 'lucide-react';
import { JSX, useMemo, useState } from 'react';
import { AgentActionViewer } from './agent-action-viewer';
import { AgentLogViewer } from './agent-log-viewer';
import { AgentMemoryViewer } from './agent-memory-viewer';
import { Skeleton } from './ui/skeleton';

type AgentSidebarProps = {
  agentId: UUID | undefined;
  agentName: string;
};

type FixedTabValue = 'details' | 'actions' | 'logs' | 'memories';
type TabValue = FixedTabValue | string;

export function AgentSidebar({ agentId, agentName }: AgentSidebarProps) {
  const [detailsTab, setDetailsTab] = useState<TabValue>('details');
  const { data: panelsResponse, isLoading: isLoadingPanels } = useAgentPanels(agentId!, { enabled: !!agentId });

  const agentPanels = useMemo(() => {
    return panelsResponse?.data || [];
  }, [panelsResponse]);

  const allTabs: { value: TabValue; label: string; icon: JSX.Element }[] = useMemo(() => {
    const fixedTabs: { value: FixedTabValue; label: string; icon: JSX.Element }[] = [
      { value: 'details', label: 'Details', icon: <InfoIcon className="h-4 w-4" /> },
      { value: 'actions', label: 'Actions', icon: <Eye className="h-4 w-4" /> },
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
      onValueChange={(v: TabValue) => setDetailsTab(v)}
      className="flex flex-col h-full"
    >
      <TabsList className="flex">
        {allTabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="flex items-center gap-1.5">
            {tab.icon}
            <span>{tab.label}</span>
          </TabsTrigger>
        ))}
        {isLoadingPanels && (
          <>
            {[...Array(2)].map((_, i) => (
              <Skeleton key={`skel-tab-${i}`} className="h-9 w-full rounded-md" />
            ))}
          </>
        )}
      </TabsList>

      <TabsContent value="details" className="overflow-y-auto flex-1">
        {detailsTab === 'details' && agentId && (
          <div className="p-4">
            Agent Settings for {agentName} (ID: {agentId}) will go here.
          </div>
        )}
        {detailsTab === 'details' && !agentId && (
          <div className="p-4 text-muted-foreground">
            Select an agent to see their details.
          </div>
        )}
      </TabsContent>

      <TabsContent value="actions" className="overflow-y-auto flex-1">
        {detailsTab === 'actions' && agentId && <AgentActionViewer agentId={agentId} />}
        {detailsTab === 'actions' && !agentId && (
          <div className="p-4 text-muted-foreground">
            Select an agent to see their actions.
          </div>
        )}
      </TabsContent>
      <TabsContent value="logs" className="overflow-y-auto flex-1">
        {detailsTab === 'logs' && agentId && <AgentLogViewer agentName={agentName} level="all" />}
        {detailsTab === 'logs' && !agentId && (
          <div className="p-4 text-muted-foreground">
            Select an agent to see their logs.
          </div>
        )}
      </TabsContent>
      <TabsContent value="memories" className="overflow-y-auto flex-1">
        {detailsTab === 'memories' && agentId && <AgentMemoryViewer agentId={agentId} agentName={agentName} />}
        {detailsTab === 'memories' && !agentId && (
          <div className="p-4 text-muted-foreground">
            Select an agent to see their memories.
          </div>
        )}
      </TabsContent>
      {agentPanels.map((panel: AgentPanel) => (
        <TabsContent key={panel.name} value={panel.name} className="overflow-y-auto flex-1">
          {detailsTab === panel.name && agentId && (
            <iframe
              src={`${panel.path}?agentId=${agentId}`}
              title={panel.name}
              className="w-full h-full border-0 flex-1"
            />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}
