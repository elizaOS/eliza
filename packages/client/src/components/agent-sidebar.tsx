import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Activity, Book, Database, Terminal, Columns3 } from 'lucide-react';
import { AgentLogViewer } from './agent-log-viewer';
import { AgentMemoryViewer } from './agent-memory-viewer';
import { KnowledgeManager } from './agent-knowledge-manager';
import type { UUID } from '@elizaos/core';
import { useAgentPanels, type AgentPanel } from '@/hooks/use-query-hooks';
import { useState, useMemo, JSX } from 'react';
import { Skeleton } from './ui/skeleton';
import { AgentActionViewer } from './agent-action-viewer';

type AgentSidebarProps = {
  agentId: UUID;
  agentName: string;
};

type FixedTabValue = 'actions' | 'logs' | 'memories' | 'knowledge';
type TabValue = FixedTabValue | string;

export function AgentSidebar({ agentId, agentName }: AgentSidebarProps) {
  const [detailsTab, setDetailsTab] = useState<TabValue>('actions');
  const { data: panelsResponse, isLoading: isLoadingPanels } = useAgentPanels(agentId);

  const agentPanels = useMemo(() => {
    return panelsResponse?.data || [];
  }, [panelsResponse]);

  const allTabs: { value: TabValue; label: string; icon: JSX.Element }[] = useMemo(() => {
    const fixedTabs: { value: FixedTabValue; label: string; icon: JSX.Element }[] = [
      { value: 'actions', label: 'Actions', icon: <Activity className="h-4 w-4" /> },
      { value: 'memories', label: 'Memories', icon: <Database className="h-4 w-4" /> },
      { value: 'knowledge', label: 'Knowledge', icon: <Book className="h-4 w-4" /> },
      { value: 'logs', label: 'Logs', icon: <Terminal className="h-4 w-4" /> },
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
      onValueChange={(v) => setDetailsTab(v as TabValue)}
      className="flex flex-col h-full"
    >
      <div className="border-b px-4 py-2">
        <TabsList className={`flex justify-evenly`}>
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
      </div>

      <TabsContent value="actions" className="overflow-y-auto flex-1">
        {detailsTab === 'actions' && <AgentActionViewer agentId={agentId} />}
      </TabsContent>
      <TabsContent value="logs" className="overflow-y-auto flex-1">
        {detailsTab === 'logs' && <AgentLogViewer agentName={agentName} level="all" hideTitle />}
      </TabsContent>
      <TabsContent value="memories" className="overflow-y-auto flex-1">
        {detailsTab === 'memories' && <AgentMemoryViewer agentId={agentId} agentName={agentName} />}
      </TabsContent>
      <TabsContent value="knowledge" className="h-full overflow-hidden flex-1">
        {detailsTab === 'knowledge' && <KnowledgeManager agentId={agentId} />}
      </TabsContent>

      {agentPanels.map((panel: AgentPanel) => (
        <TabsContent
          key={panel.name}
          value={panel.name}
          className="h-full overflow-hidden flex-1 flex flex-col"
        >
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
