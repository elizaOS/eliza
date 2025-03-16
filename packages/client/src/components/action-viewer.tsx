import type { UUID, ModelType } from '@elizaos/core';
import { Bot, Brain, ImagePlusIcon, Trash2 } from 'lucide-react';
import { useAgentActions, useDeleteLog } from '../hooks/use-query-hooks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

export function AgentActionViewer({ agentId, roomId }: { agentId: UUID; roomId?: UUID }) {
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

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  };

  const getModelIcon = (modelType: string) => {
    if (modelType?.includes('TEXT_EMBEDDING')) return <Brain className="w-4 h-4" />;
    if (modelType?.includes('LLM')) return <Bot className="w-4 h-4" />;
    if (modelType?.includes('IMAGE')) return <ImagePlusIcon className="w-4 h-4" />;
    return <Brain className="w-4 h-4" />;
  };

  const handleDelete = (logId: string) => {
    if (logId && window.confirm('Are you sure you want to delete this log entry?')) {
      deleteLog({ agentId, logId });
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-200px)] min-h-[400px] w-full">
      <div className="flex justify-between items-center mb-4 px-4 pt-4 flex-none">
        <h3 className="text-lg font-medium">Agent Actions</h3>
      </div>
      <div
        className="flex-1 overflow-y-auto px-4 pb-4"
        style={{ height: 'calc(100% - 60px)', overflowY: 'auto' }}
      >
        {actions.length === 0 ? (
          <div className="text-muted-foreground text-center p-4">No actions recorded yet</div>
        ) : (
          <div className="space-y-3">
            {actions.map((action, index) => {
              const modelType = action.body?.modelType || '';
              const actionType = action.type || 'Action';

              return (
                <div
                  key={action.id || index}
                  className="border rounded-md p-3 bg-card hover:bg-accent/10 transition-colors relative group"
                >
                  {action.id && (
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-50"
                      onClick={() => handleDelete(action.id!)}
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

                  <div className="mt-2 grid gap-2 rounded-full">
                    {action.body?.modelKey && (
                      <div className="text-xs bg-muted px-2 py-1 rounded">
                        <span className="font-semibold">Model: </span>
                        {action.body.modelKey}
                      </div>
                    )}

                    {action.body?.params && (
                      <div className="text-xs overflow-hidden">
                        <span className="font-semibold">Params: </span>
                        {typeof action.body.params === 'object'
                          ? JSON.stringify(action.body.params, null, 2)
                          : action.body.params}
                      </div>
                    )}

                    {action.body?.response && (
                      <div
                        className={
                          action.body.response === '[array]'
                            ? 'text-xs italic text-muted-foreground'
                            : 'text-xs overflow-hidden max-h-24 overflow-y-auto'
                        }
                      >
                        {action.body.response === '[array]' ? (
                          'Response contains array data'
                        ) : (
                          <>
                            <span className="font-semibold">Response: </span>
                            {typeof action.body.response === 'object'
                              ? JSON.stringify(action.body.response, null, 2)
                              : action.body.response}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
