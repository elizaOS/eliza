import type { UUID } from '@elizaos/core';
import { Bot, Brain, ImagePlusIcon, Trash2, LoaderIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentActions, useDeleteLog } from '../hooks/use-query-hooks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

// Constants
const ITEMS_PER_PAGE = 10;

// Enums
enum ActionType {
  all = 'all',
  llm = 'llm',
  embedding = 'embedding',
  image = 'image',
  other = 'other',
}

// Types
type AgentAction = {
  id: string;
  type: string;
  createdAt: number;
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

type AgentActionViewerProps = {
  agentId: UUID;
  roomId?: UUID;
};

// Helper functions
function getModelUsageType(modelType: string): string {
  if (
    (modelType.includes('TEXT') || modelType.includes('OBJECT')) &&
    !modelType.includes('EMBEDDING')
  ) {
    return 'LLM';
  }
  if (modelType.includes('EMBEDDING')) {
    return 'Embedding';
  }
  if (modelType.includes('IMAGE')) {
    return 'Image';
  }
  if (
    !modelType.includes('TEXT') &&
    !modelType.includes('IMAGE') &&
    !modelType.includes('EMBEDDING')
  ) {
    return 'Other';
  }
  return 'Unknown';
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}
function getModelIcon(modelType = '') {
  if (modelType.includes('TEXT_EMBEDDING')) return <Brain className="w-4 h-4" />;
  if (modelType.includes('LLM')) return <Bot className="w-4 h-4" />;
  if (modelType.includes('IMAGE')) return <ImagePlusIcon className="w-4 h-4" />;
  return <Brain className="w-4 h-4" />;
}

function groupActionsByDate(actions: AgentAction[]) {
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
}

// Components
function ActionCard({ action, onDelete }: ActionCardProps) {
  const renderActionContent = () => {
    const { body } = action;

    return (
      <div className="mt-2 grid gap-2">
        {/* Model Info */}
        {body?.modelKey && (
          <div className="bg-muted/40 px-2 py-1 rounded flex items-center">
            <span className="text-xs font-semibold text-muted-foreground mr-1">Model:</span>
            <code className="text-xs font-mono">{body.modelKey}</code>
          </div>
        )}

        {/* Parameters */}
        {body?.params && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium text-muted-foreground">Parameters</span>
            </div>
            <div className="bg-muted/30 px-3 py-2 rounded">
              <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                {typeof body.params === 'object'
                  ? JSON.stringify(body.params, null, 2)
                  : body.params}
              </pre>
            </div>
          </div>
        )}

        {/* Response */}
        {body?.response && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium text-muted-foreground">Response</span>
            </div>
            <div className="bg-muted/30 px-3 py-2 rounded max-h-48 overflow-y-auto">
              {body.response === '[array]' ? (
                <span className="text-xs italic text-muted-foreground">
                  Response contains array data
                </span>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                  {typeof body.response === 'object'
                    ? JSON.stringify(body.response, null, 2)
                    : body.response}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* Usage Id */}
        {action.id && (
          <div className="bg-muted/40 px-2 py-1 rounded flex items-center">
            <span className="text-xs font-semibold text-muted-foreground mr-1">ID:</span>
            <code className="text-xs font-mono">{action.id}</code>
          </div>
        )}
      </div>
    );
  };

  const modelType = action.body?.modelType || '';

  return (
    <div className="border mt-2 rounded-md p-3 bg-card hover:bg-accent/10 transition-colors relative group">
      {/* Delete Button */}
      {action.id && onDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-50 h-7 w-7 hover:bg-muted"
          onClick={() => onDelete(action.id)}
          title="Delete log entry"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium flex items-center gap-1.5">
            {getModelIcon(modelType)}
          </span>
          <Badge variant="outline" className="text-xs">
            {modelType}
          </Badge>
        </div>
        <Badge variant="secondary" className="text-xs group-hover:mr-8 transition-all">
          {formatDate(action.createdAt || 0)}
        </Badge>
      </div>

      {/* Content */}
      {renderActionContent()}
    </div>
  );
}

function LoadingIndicator({
  loadingMore,
  onLoadMore,
}: {
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex justify-center p-4">
      {loadingMore ? (
        <div className="flex items-center gap-2">
          <LoaderIcon className="h-4 w-4 animate-spin" />
          <span className="text-sm text-muted-foreground">Loading more...</span>
        </div>
      ) : (
        <Button variant="ghost" size="sm" onClick={onLoadMore} className="text-xs">
          Show more
        </Button>
      )}
    </div>
  );
}

function EmptyState({ selectedType }: { selectedType: ActionType }) {
  return (
    <div className="text-muted-foreground text-center p-12 flex flex-col items-center gap-3 border-2 border-dashed rounded-lg mt-8">
      <Brain className="h-12 w-12 text-muted-foreground opacity-20" />
      <h3 className="text-lg font-medium">No Actions</h3>
      <p className="max-w-md text-sm">
        {selectedType === ActionType.all
          ? 'Actions will appear here once the agent has performed operations.'
          : `No ${selectedType} actions found.`}
      </p>
    </div>
  );
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
    const usageType = getModelUsageType(modelType);

    switch (selectedType) {
      case ActionType.llm:
        return usageType === 'LLM';
      case ActionType.embedding:
        return usageType === 'Embedding';
      case ActionType.image:
        return usageType === 'Image';
      case ActionType.other:
        return usageType === 'Other' || usageType === 'Unknown';
      default:
        return true;
    }
  });

  const visibleActions = filteredActions as AgentAction[];
  const hasMoreToLoad = visibleItems < filteredActions.length;
  const actionGroups = groupActionsByDate(visibleActions);

  const handleDelete = (logId: string) => {
    if (window.confirm('Are you sure you want to delete this log entry?')) {
      deleteLog({ agentId, logId });
    }
  };

  const handleLoadMore = () => {
    setVisibleItems((prev) => prev + ITEMS_PER_PAGE);
  };

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
          <EmptyState selectedType={selectedType} />
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
            {hasMoreToLoad && (
              <LoadingIndicator loadingMore={loadingMore} onLoadMore={handleLoadMore} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
