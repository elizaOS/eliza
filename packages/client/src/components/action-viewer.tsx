import type { UUID } from '@elizaos/core';
import { Bot, Brain, ImagePlusIcon, Trash2 } from 'lucide-react';
import { LoaderIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentActions, useDeleteLog } from '../hooks/use-query-hooks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

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

// Add constant for pagination
const ITEMS_PER_PAGE = 10;

// Add enum for action types
enum ActionType {
  all = 'all',
  llm = 'llm',
  embedding = 'embedding',
  image = 'image',
  other = 'other',
}

export function AgentActionViewer({ agentId, roomId }: AgentActionViewerProps) {
  const [selectedType, setSelectedType] = useState<ActionType>(ActionType.all);
  const [visibleItems, setVisibleItems] = useState(ITEMS_PER_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const { data: actions = [], isLoading, error } = useAgentActions(agentId, roomId);
  const { mutate: deleteLog } = useDeleteLog();

  // Handle scroll to implement infinite loading
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current || loadingMore || visibleItems >= actions.length) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const scrolledToBottom = scrollTop + clientHeight >= scrollHeight - 100; // 100px buffer

    if (scrolledToBottom) {
      setLoadingMore(true);
      setTimeout(() => {
        setVisibleItems((prev) => Math.min(prev + ITEMS_PER_PAGE, actions.length));
        setLoadingMore(false);
      }, 300);
    }
  }, [loadingMore, visibleItems, actions.length]);

  // Reset visible items when new data loads
  useEffect(() => {
    setVisibleItems(ITEMS_PER_PAGE);
  }, []);

  // Set up scroll event listener
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScroll);
      return () => scrollContainer.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  // Filter actions based on selected type
  const filteredActions = actions.filter((action: AgentAction) => {
    if (selectedType === ActionType.all) return true;

    const modelType = action.body?.modelType || '';

    switch (selectedType) {
      case ActionType.llm:
        return (
          (modelType.includes('TEXT') || modelType.includes('OBJECT')) &&
          !modelType.includes('EMBEDDING')
        );
      case ActionType.embedding:
        return modelType.includes('EMBEDDING');
      case ActionType.image:
        return modelType.includes('IMAGE');
      case ActionType.other:
        return (
          !modelType.includes('TEXT') &&
          !modelType.includes('IMAGE') &&
          !modelType.includes('EMBEDDING')
        );
      default:
        return true;
    }
  });

  // Group actions by date
  const groupActionsByDate = (actions: AgentAction[]) => {
    const groups: Record<string, AgentAction[]> = {};

    for (const action of actions) {
      const date = new Date(action.createdAt || 0);
      const dateKey = date.toLocaleDateString();

      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(action);
    }

    return groups;
  };

  const visibleActions = filteredActions.slice(0, visibleItems);
  const hasMoreToLoad = visibleItems < filteredActions.length;
  const actionGroups = groupActionsByDate(visibleActions);

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

  const LoadingIndicator = () => (
    <div className="flex justify-center p-4">
      {loadingMore ? (
        <div className="flex items-center gap-2">
          <LoaderIcon className="h-4 w-4 animate-spin" />
          <span className="text-sm text-muted-foreground">Loading more...</span>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setVisibleItems((prev) => prev + ITEMS_PER_PAGE)}
          className="text-xs"
        >
          Show more
        </Button>
      )}
    </div>
  );

  const EmptyState = () => (
    <div className="text-muted-foreground text-center p-12 flex flex-col items-center gap-3 border-2 border-dashed rounded-lg mt-8">
      <Brain className="h-12 w-12 text-muted-foreground opacity-20" />
      <h3 className="text-lg font-medium">No Actions</h3>
      <p className="max-w-md text-sm">
        Actions will appear here once the agent performs operations.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
      <div className="flex justify-between items-center mb-4 px-4 pt-4 flex-none border-b pb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-medium">Agent Actions</h3>
          {!isLoading && (
            <Badge variant="secondary" className="ml-2">
              {filteredActions.length} actions
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={selectedType}
            onValueChange={(value) => setSelectedType(value as ActionType)}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Filter actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ActionType.all}>All Actions</SelectItem>
              <SelectItem value={ActionType.llm}>LLM Calls</SelectItem>
              <SelectItem value={ActionType.embedding}>Embeddings</SelectItem>
              <SelectItem value={ActionType.image}>Image Operations</SelectItem>
              <SelectItem value={ActionType.other}>Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-4 pb-4 h-[calc(100vh-60px)]"
      >
        {filteredActions.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {Object.entries(actionGroups).map(([date, actions]) => (
              <div key={date} className="mb-4">
                <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm mb-2 pb-1 pt-2">
                  <Badge variant="outline" className="text-xs">
                    {date}
                  </Badge>
                </div>
                <div className="space-y-1">
                  {actions.map((action, index) => (
                    <ActionCard key={action.id || index} action={action} onDelete={handleDelete} />
                  ))}
                </div>
              </div>
            ))}
            {hasMoreToLoad && <LoadingIndicator />}
          </div>
        )}
      </div>
    </div>
  );
}
