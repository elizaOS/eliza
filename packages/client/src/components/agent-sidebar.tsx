import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Activity, Book, Database, Terminal } from 'lucide-react';
import { AgentActionViewer } from './action-viewer';
import { LogViewer } from './log-viewer';
import { AgentMemoryViewer } from './memory-viewer';
import { KnowledgeManager } from './knowledge-manager';
import type { UUID } from '@elizaos/core';
import { useState } from 'react';

type AgentSidebarProps = {
  agentId: UUID;
  agentName: string;
};

export function AgentSidebar({ agentId, agentName }: AgentSidebarProps) {
  const [detailsTab, setDetailsTab] = useState<'actions' | 'logs' | 'memories' | 'knowledge'>(
    'actions'
  );
  return (
    <Tabs
      defaultValue="actions"
      value={detailsTab}
      onValueChange={(v) => setDetailsTab(v as 'actions' | 'logs' | 'memories' | 'knowledge')}
      className="flex flex-col h-full"
    >
      <div className="border-b px-4 py-2">
        <TabsList className="grid grid-cols-4">
          <TabsTrigger value="actions" className="flex items-center gap-1.5">
            <Activity className="h-4 w-4" />
            <span>Actions</span>
          </TabsTrigger>
          <TabsTrigger value="memories" className="flex items-center gap-1.5">
            <Database className="h-4 w-4" />
            <span>Memories</span>
          </TabsTrigger>
          <TabsTrigger value="knowledge" className="flex items-center gap-1.5">
            <Book className="h-4 w-4" />
            <span>Knowledge</span>
          </TabsTrigger>
          <TabsTrigger value="logs" className="flex items-center gap-1.5">
            <Terminal className="h-4 w-4" />
            <span>Logs</span>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="actions" className="overflow-y-scroll">
        <AgentActionViewer agentId={agentId} />
      </TabsContent>
      <TabsContent value="logs">
        <LogViewer agentName={agentName} level="all" hideTitle />
      </TabsContent>
      <TabsContent value="memories">
        <AgentMemoryViewer agentId={agentId} />
      </TabsContent>
      <TabsContent value="knowledge">
        <KnowledgeManager agentId={agentId} />
      </TabsContent>
    </Tabs>
  );
}
