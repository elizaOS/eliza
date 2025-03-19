import type { UUID } from '@elizaos/core';
import { Bot, Brain, ImagePlusIcon, Trash2 } from 'lucide-react';
import { useAgentActions, useDeleteLog } from '../hooks/use-query-hooks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';

type AgentAction = {
  id?: string;
  type?: string;
  createdAt?: number;
  body?: {
    modelType?: string;
    modelKey?: string;
    params?: any;
    response?: any;
  };
};

type ActionCardProps = {
  action: AgentAction;
  onDelete?: (logId: string) => void;
};

// Internal ActionCard component
function ActionCard({ action, onDelete }: ActionCardProps) {
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  };

  const getModelIcon = (modelType = '') => {
    if (modelType.includes('TEXT_EMBEDDING')) return <Brain className="w-4 h-4" />;
    if (modelType.includes('LLM')) return <Bot className="w-4 h-4" />;
    if (modelType.includes('IMAGE')) return <ImagePlusIcon className="w-4 h-4" />;
    return <Brain className="w-4 h-4" />;
  };

  const renderActionContent = () => {
    const { body } = action;

    return (
      <>
        {body?.modelKey && (
          <div className="text-xs bg-muted px-2 py-1 rounded">
            <span className="font-semibold">Model: </span>
            {body.modelKey}
          </div>
        )}

        {body?.params && (
          <div className="text-xs overflow-hidden">
            <span className="font-semibold">Params: </span>
            {typeof body.params === 'object' ? JSON.stringify(body.params, null, 2) : body.params}
          </div>
        )}

        {body?.response && (
          <div
            className={
              body.response === '[array]'
                ? 'text-xs italic text-muted-foreground'
                : 'text-xs overflow-hidden max-h-24 overflow-y-auto'
            }
          >
            {body.response === '[array]' ? (
              'Response contains array data'
            ) : (
              <>
                <span className="font-semibold">Response: </span>
                {typeof body.response === 'object'
                  ? JSON.stringify(body.response, null, 2)
                  : body.response}
              </>
            )}
          </div>
        )}
      </>
    );
  };

  const modelType = action.body?.modelType || '';
  const actionType = action.type || 'Action';

  return (
    <div className="border mt-2 rounded-md p-3 bg-card hover:bg-accent/10 transition-colors relative group">
      {action.id && onDelete && (
        <Button
          variant="secondary"
          size="icon"
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-50"
          onClick={() => onDelete(action.id!)}
          title="Delete log entry"
        >
          <Trash2 className="h-4 w-4 text-regular" />
        </Button>
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium flex items-center gap-2">
          {getModelIcon(modelType)} {actionType}
        </span>
        <Badge variant="outline" className="text-xs group-hover:mr-8 transition-all">
          {formatDate(action.createdAt)}
        </Badge>
      </div>

      <div className="mt-2 grid gap-2 rounded-full">{renderActionContent()}</div>
    </div>
  );
}

type AgentActionViewerProps = {
  agentId: UUID;
  roomId?: UUID;
};

export function AgentActionViewer({ agentId, roomId }: AgentActionViewerProps) {
  const { data: actions = [], isLoading, error } = useAgentActions(agentId, roomId);
  const { mutate: deleteLog } = useDeleteLog();

  if (isLoading && (!actions || actions.length === 0)) {
    return <div className="flex items-center justify-center h-40">Loading actions...</div>;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-40 text-destructive">
        Error loading agent actions
      </div>
    );
  }

  const handleDelete = (logId: string) => {
    if (window.confirm('Are you sure you want to delete this log entry?')) {
      deleteLog({ agentId, logId });
    }
  };

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex justify-between items-center mb-4 px-4 pt-4 flex-none">
        <h3 className="text-lg font-medium">Agent Actions</h3>
      </div>
      <ScrollArea className="h-full w-full px-4">
        {actions.length === 0 ? (
          <div className="text-muted-foreground text-center p-4">No actions recorded yet</div>
        ) : (
          actions.map((action, index) => (
            <ActionCard key={action.id || index} action={action} onDelete={handleDelete} />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
