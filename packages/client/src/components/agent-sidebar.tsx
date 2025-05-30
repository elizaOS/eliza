import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAgentPanels, type AgentPanel } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';
import { Columns3, Database, Eye, Code } from 'lucide-react';
import { JSX, useMemo, useState } from 'react';
import { AgentActionViewer } from './agent-action-viewer';
import { AgentLogViewer } from './agent-log-viewer';
import { AgentMemoryViewer } from './agent-memory-viewer';
import { Skeleton } from './ui/skeleton';

type AgentSidebarProps = {
  agentId: UUID;
  agentName: string;
};

type FixedTabValue = 'actions' | 'logs' | 'memories';
type TabValue = FixedTabValue | string;

export function AgentSidebar({ agentId, agentName }: AgentSidebarProps) {
  const [detailsTab, setDetailsTab] = useState<TabValue>('actions');
  const { data: panelsResponse, isLoading: isLoadingPanels } = useAgentPanels(agentId);

  const agentPanels = useMemo(() => {
    return panelsResponse?.data || [];
  }, [panelsResponse]);

  const allTabs: { value: TabValue; label: string; icon: JSX.Element }[] = useMemo(() => {
    const fixedTabs: { value: FixedTabValue; label: string; icon: JSX.Element }[] = [
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
      defaultValue="actions"
      value={detailsTab}
      onValueChange={(v: TabValue) => setDetailsTab(v)}
      className="flex flex-col h-full"
    >
      <TabsList className="flex">
        {isLoadingPanels && (
          <>
            {[...Array(2)].map((_, i) => (
              <Skeleton key={`skel-tab-${i}`} className="h-9 w-full rounded-md" />
            ))}
          </>
        )}
        {allTabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="flex items-center gap-1.5">
            {tab.icon}
            <span>{tab.label}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="actions" className="overflow-y-auto flex-1">
        {detailsTab === 'actions' && <AgentActionViewer agentId={agentId} />}
      </TabsContent>
      <TabsContent value="logs" className="overflow-y-auto flex-1">
        {detailsTab === 'logs' && <AgentLogViewer agentName={agentName} level="all" />}
      </TabsContent>
      <TabsContent value="memories" className="overflow-y-auto flex-1">
        {detailsTab === 'memories' && <AgentMemoryViewer agentId={agentId} agentName={agentName} />}
      </TabsContent>
      {agentPanels.map((panel: AgentPanel) => (
        <TabsContent key={panel.name} value={panel.name} className="overflow-y-auto flex-1">
          {detailsTab === panel.name && (
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
