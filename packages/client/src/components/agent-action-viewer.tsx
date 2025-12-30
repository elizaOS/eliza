import type { UUID } from '@elizaos/core';
import type { AgentLog } from '@/lib/api-type-mappers';
import {
  Bot,
  Brain,
  ImagePlusIcon,
  Trash2,
  LoaderIcon,
  Search,
  Clock,
  Database,
  Zap,
  Activity,
  FileText,
  Copy,
  ChevronDown,
  ChevronUp,
  AlertCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentActions, useDeleteLog } from '@/hooks/use-query-hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { useConfirmation } from '@/hooks/use-confirmation';
import ConfirmationDialog from './confirmation-dialog';

// Constants
const ITEMS_PER_PAGE = 15;

// Enums
enum ActionType {
  all = 'all',
  llm = 'llm',
  embedding = 'embedding',
  transcription = 'transcription',
  image = 'image',
  other = 'other',
}

// Types
type ActionCardProps = {
  action: AgentLog;
  onDelete?: (logId: string) => void;
};

type AgentActionViewerProps = {
  agentId: UUID;
  roomId?: UUID;
};

// Helper functions
function getModelUsageType(modelType: string): string {
  if (
    (modelType.includes('TEXT') ||
      modelType.includes('OBJECT') ||
      modelType.includes('REASONING')) &&
    !modelType.includes('EMBEDDING') &&
    !modelType.includes('TRANSCRIPTION')
  ) {
    return 'LLM';
  }
  if (modelType.includes('EMBEDDING')) {
    return 'Embedding';
  }
  if (modelType.includes('TRANSCRIPTION')) {
    return 'Transcription';
  }
  if (modelType.includes('IMAGE')) {
    return 'Image';
  }
  return 'Other';
}

function formatDate(timestamp: number | undefined) {
  if (!timestamp) return 'Unknown date';
  const date = new Date(timestamp);
  const now = new Date();
  const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

  if (diffInHours < 1) {
    const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));
    return `${diffInMinutes}m ago`;
  } else if (diffInHours < 24) {
    return `${Math.floor(diffInHours)}h ago`;
  } else if (diffInHours < 168) {
    return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  } else {
    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

function getModelIcon(modelType = '') {
  if (modelType === 'ACTION') return Zap;
  if (modelType.includes('TEXT_EMBEDDING')) return Brain;
  if (modelType.includes('TRANSCRIPTION')) return FileText;
  if (modelType.includes('TEXT') || modelType.includes('OBJECT')) return Bot;
  if (modelType.includes('IMAGE')) return ImagePlusIcon;
  return Activity;
}

function formatTokenUsage(usage: any) {
  if (!usage) return null;

  const { prompt_tokens, completion_tokens, total_tokens } = usage;
  if (!total_tokens) return null;

  return {
    prompt: prompt_tokens || 0,
    completion: completion_tokens || 0,
    total: total_tokens,
  };
}

function truncateText(text: string, maxLength = 100) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(console.error);
}

function groupActionsByDate(actions: AgentLog[]) {
  const groups: Record<string, AgentLog[]> = {};

  for (const action of actions) {
    const timestamp = action.createdAt || action.timestamp || 0;
    const date = new Date(timestamp);
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
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFullParams, setShowFullParams] = useState(false);
  const [showFullResponse, setShowFullResponse] = useState(false);

  const modelType = action.body?.modelType || '';
  const modelKey = action.body?.modelKey || '';
  const logType = action.type || '';
  const isActionLog = logType === 'action';
  const actionName = action.body?.action || '';
  const IconComponent = getModelIcon(isActionLog ? 'ACTION' : modelType || logType);
  const usageType = isActionLog ? 'Action' : getModelUsageType(modelType);
  const responseObj = typeof action.body?.response === 'object' ? action.body.response : undefined;
  const tokenUsage = formatTokenUsage(responseObj?.usage || action.body?.usage);
  const actionPrompts = action.body?.prompts;

  const renderParams = () => {
    const params = action.body?.params;

    if (!params && !actionPrompts) return null;

    if (modelType.includes('TRANSCRIPTION') && Array.isArray(params)) {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="h-3 w-3" />
          <span>Audio input data</span>
        </div>
      );
    }

    // Extract prompt from params if present (for backward compatibility)
    const { prompt, ...otherParams } = params || {};

    return (
      <div className="space-y-4">
        {/* Display multiple prompts if this is an action with prompts */}
        {actionPrompts && Array.isArray(actionPrompts) && actionPrompts.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Prompts ({actionPrompts.length})
              </span>
            </div>
            <div className="space-y-3">
              {actionPrompts.map((promptData, index) => (
                <div key={index} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {promptData.modelType || 'Prompt'} #{index + 1}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyToClipboard(promptData.prompt || '')}
                      className="h-5 px-1 text-xs"
                      title="Copy prompt"
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="bg-muted/30 rounded-md p-2">
                    <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                      {promptData.prompt}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Display single prompt from params (backward compatibility) */}
        {!actionPrompts && prompt && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Prompt</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(prompt)}
                className="h-6 px-2 text-xs"
                title="Copy prompt"
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </Button>
            </div>
            <div className="bg-muted/30 rounded-md p-3 relative">
              <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                {typeof prompt === 'string' ? prompt : JSON.stringify(prompt, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {/* Display other parameters if any */}
        {Object.keys(otherParams).length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Other Parameters</span>
              {(() => {
                const paramsText = JSON.stringify(otherParams, null, 2);
                const isLong = paramsText.length > 200;
                return isLong ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowFullParams(!showFullParams)}
                    className="h-6 px-2 text-xs"
                  >
                    {showFullParams ? 'Show less' : 'Show more'}
                  </Button>
                ) : null;
              })()}
            </div>
            <div className="bg-muted/30 rounded-md p-3 relative group">
              <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                {(() => {
                  const paramsText = JSON.stringify(otherParams, null, 2);
                  const isLong = paramsText.length > 200;
                  return showFullParams || !isLong ? paramsText : truncateText(paramsText, 200);
                })()}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(JSON.stringify(otherParams, null, 2))}
                className="absolute top-1 right-1 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Copy parameters"
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderResponse = () => {
    const response = action.body?.response;
    if (!response) return null;

    if (response === '[array]') {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Database className="h-3 w-3" />
          <span>Array response data</span>
        </div>
      );
    }

    const responseText =
      typeof response === 'object' ? JSON.stringify(response, null, 2) : String(response);
    const isLong = responseText.length > 300;

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Response</span>
          {isLong && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFullResponse(!showFullResponse)}
              className="h-6 px-2 text-xs"
            >
              {showFullResponse ? 'Show less' : 'Show more'}
            </Button>
          )}
        </div>
        <div className="bg-muted/30 rounded-md p-3 relative group max-h-64 overflow-y-auto">
          <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
            {showFullResponse || !isLong ? responseText : truncateText(responseText, 300)}
          </pre>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copyToClipboard(responseText)}
            className="absolute top-1 right-1 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Copy response"
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  };

  const hasExtendedContent =
    action.body?.params || action.body?.response || action.message || action.details;

  return (
    <div className="border rounded-lg bg-card hover:shadow-sm transition-all duration-200 group">
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 flex-1">
            <div className="p-2 rounded-lg bg-muted">
              <IconComponent className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="font-semibold text-sm">{isActionLog ? actionName : usageType}</h4>
                <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                  {isActionLog ? 'Action' : modelType || logType}
                </span>
                {action.body?.promptCount && action.body.promptCount > 1 && (
                  <Badge variant="secondary" className="text-xs px-1.5">
                    {action.body.promptCount} prompts
                  </Badge>
                )}
              </div>

              {/* Model and timing info */}
              <div className="space-y-1">
                {(modelKey || isActionLog) && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Zap className="h-3 w-3" />
                    <code className="font-mono">
                      {isActionLog
                        ? `Action ID: ${action.body?.actionId?.slice(-8) || 'N/A'}`
                        : modelKey}
                    </code>
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>{formatDate(action.createdAt || action.timestamp)}</span>
                  {action.id && (
                    <>
                      <span>•</span>
                      <code className="text-[10px] bg-muted px-1 rounded">
                        {action.id.slice(-8)}
                      </code>
                    </>
                  )}
                </div>
              </div>

              {/* Token usage */}
              {tokenUsage && (
                <div className="flex items-center gap-4 mt-2 text-xs">
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Tokens:</span>
                    <span className="font-mono">{tokenUsage.total.toLocaleString()}</span>
                  </div>
                  {tokenUsage.prompt > 0 && (
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span>In:</span>
                      <span className="font-mono">{tokenUsage.prompt.toLocaleString()}</span>
                    </div>
                  )}
                  {tokenUsage.completion > 0 && (
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <span>Out:</span>
                      <span className="font-mono">{tokenUsage.completion.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {hasExtendedContent && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="h-8 w-8 p-0"
                title={isExpanded ? 'Collapse details' : 'Expand details'}
              >
                {isExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </Button>
            )}
            {action.id && onDelete && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (typeof action.id === 'string') {
                    onDelete(action.id);
                  }
                }}
                className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                title="Delete log entry"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Expandable content */}
      {isExpanded && hasExtendedContent && (
        <>
          <Separator />
          <div className="p-4 pt-3 space-y-4">
            {renderParams()}
            {renderResponse()}

            {/* Additional metadata */}
            {(action.message || action.details) && (
              <div className="space-y-2">
                <span className="text-xs font-medium text-muted-foreground">Additional Info</span>
                <div className="bg-muted/30 rounded-md p-3">
                  {action.message && (
                    <div className="text-xs mb-2">
                      <span className="font-medium text-muted-foreground">Message: </span>
                      <span>{action.message}</span>
                    </div>
                  )}
                  {action.details && (
                    <div className="text-xs">
                      <span className="font-medium text-muted-foreground">Details: </span>
                      <span>{action.details}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Quick preview for collapsed state */}
      {!isExpanded && hasExtendedContent && (
        <>
          <Separator />
          <div className="p-4 pt-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              <span>
                {(() => {
                  const parts = [];
                  if (action.body?.promptCount && action.body.promptCount > 0) {
                    parts.push(
                      `${action.body.promptCount} prompt${action.body.promptCount > 1 ? 's' : ''}`
                    );
                  }
                  if (action.body?.params) parts.push('parameters');
                  if (action.body?.response) parts.push('response data');
                  return parts.length > 0
                    ? `Contains ${parts.join(' and ')}`
                    : 'Contains additional data';
                })()}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(true)}
                className="h-5 px-2 text-xs ml-auto"
              >
                View details
              </Button>
            </div>
          </div>
        </>
      )}
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
    <div className="flex justify-center py-6">
      {loadingMore ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <LoaderIcon className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading more actions...</span>
        </div>
      ) : (
        <Button variant="outline" onClick={onLoadMore} className="px-8">
          Load More
        </Button>
      )}
    </div>
  );
}

function EmptyState({
  selectedType,
  searchQuery,
}: {
  selectedType: ActionType;
  searchQuery: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 text-center p-8">
      <Database className="h-16 w-16 text-muted-foreground/30 mb-4" />
      <h3 className="text-lg font-medium mb-2">No Actions Found</h3>
      <p className="text-muted-foreground max-w-md mb-4">
        {searchQuery
          ? `No actions match "${searchQuery}". Try adjusting your search or filter.`
          : selectedType === ActionType.all
            ? 'Actions will appear here once the agent has performed operations.'
            : `No ${selectedType} actions found.`}
      </p>
      {searchQuery && (
        <Button variant="outline" onClick={() => {}}>
          Clear Search
        </Button>
      )}
    </div>
  );
}

export function AgentActionViewer({ agentId, roomId }: AgentActionViewerProps) {
  const [selectedType, setSelectedType] = useState<ActionType>(ActionType.all);
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleItems, setVisibleItems] = useState(ITEMS_PER_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Exclude embedding operations by default
  const excludeTypes = ['embedding', 'text_embedding'];

  const { data: actions = [], isLoading, error } = useAgentActions(agentId, roomId, excludeTypes);
  const { mutate: deleteLog } = useDeleteLog();

  const { confirm, isOpen, onOpenChange, onConfirm, options } = useConfirmation();

  // Filter and search actions
  const filteredActions = actions.filter((action: AgentLog) => {
    // Type filter
    if (selectedType !== ActionType.all) {
      const modelType = action.body?.modelType || '';
      const usageType = getModelUsageType(modelType);
      const isActionLog = action.type === 'action';

      switch (selectedType) {
        case ActionType.llm:
          // Only show LLM model calls (not actions)
          if (usageType !== 'LLM') return false;
          break;
        case ActionType.embedding:
          if (usageType !== 'Embedding') return false;
          break;
        case ActionType.transcription:
          if (usageType !== 'Transcription') return false;
          break;
        case ActionType.image:
          if (usageType !== 'Image') return false;
          break;
        case ActionType.other:
          // "Other" includes actions and unknown model types
          if (usageType !== 'Other' && usageType !== 'Unknown' && !isActionLog) return false;
          break;
      }
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const searchableText = [
        action.body?.modelType,
        action.body?.modelKey,
        action.id,
        action.message,
        JSON.stringify(action.body?.params),
        JSON.stringify(action.body?.response),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchableText.includes(query);
    }

    return true;
  });

  // Handle scroll for infinite loading
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current || loadingMore || visibleItems >= filteredActions.length) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const scrolledToBottom = scrollTop + clientHeight >= scrollHeight - 200;

    if (scrolledToBottom) {
      setLoadingMore(true);
      setTimeout(() => {
        setVisibleItems((prev) => Math.min(prev + ITEMS_PER_PAGE, filteredActions.length));
        setLoadingMore(false);
      }, 500);
    }
  }, [loadingMore, visibleItems, filteredActions.length]);

  // Reset visible items when filter changes
  useEffect(() => {
    setVisibleItems(ITEMS_PER_PAGE);
  }, [selectedType, searchQuery]);

  // Set up scroll listener
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScroll);
      return () => scrollContainer.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  const visibleActions = filteredActions.slice(0, visibleItems);
  const hasMoreToLoad = visibleItems < filteredActions.length;
  const actionGroups = groupActionsByDate(visibleActions);

  const handleDelete = (logId: string) => {
    confirm(
      {
        title: 'Delete Log Entry',
        description:
          'Are you sure you want to permanently delete this log entry? This action cannot be undone.',
        confirmText: 'Delete',
        variant: 'destructive',
      },
      () => {
        deleteLog({ agentId, logId: logId as UUID });
      }
    );
  };

  const handleLoadMore = () => {
    setVisibleItems((prev) => prev + ITEMS_PER_PAGE);
  };

  // Loading state
  if (isLoading && actions.length === 0) {
    return (
      <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
        <div className="flex items-center justify-center flex-1">
          <div className="flex flex-col items-center gap-4">
            <LoaderIcon className="h-8 w-8 animate-spin text-muted-foreground" />
            <div className="text-center">
              <h3 className="font-medium">Loading Actions</h3>
              <p className="text-sm text-muted-foreground">Fetching agent action history...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
        <div className="flex items-center justify-center flex-1">
          <div className="text-center">
            <Database className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h3 className="font-medium text-destructive">Failed to Load Actions</h3>
            <p className="text-sm text-muted-foreground">
              There was an error loading the agent actions.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
        {/* Header */}
        <div className="flex justify-between items-center mb-4 px-4 pt-4 flex-none border-b pb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-medium"> Actions</h3>
            {!isLoading && (
              <span className="ml-2 text-xs px-2 py-1 rounded bg-muted text-muted-foreground">
                {filteredActions.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search actions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 w-64"
              />
            </div>
            {/* Filter */}
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
                <SelectItem value={ActionType.transcription}>Transcriptions</SelectItem>
                <SelectItem value={ActionType.image}>Image Operations</SelectItem>
                <SelectItem value={ActionType.other}>Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Content */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4">
          {filteredActions.length === 0 ? (
            <EmptyState selectedType={selectedType} searchQuery={searchQuery} />
          ) : (
            <div className="space-y-4">
              {Object.entries(actionGroups).map(([date, actions]) => (
                <div key={date} className="space-y-3">
                  <div className="flex items-center gap-3 py-2">
                    <Separator className="flex-1" />
                    <span className="text-sm font-medium text-muted-foreground px-2">{date}</span>
                    <Separator className="flex-1" />
                  </div>
                  <div className="space-y-3">
                    {actions.map((action, index) => (
                      <ActionCard
                        key={action.id || index}
                        action={action}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              ))}

              {/* Load more */}
              {hasMoreToLoad && (
                <LoadingIndicator loadingMore={loadingMore} onLoadMore={handleLoadMore} />
              )}
            </div>
          )}
        </div>
      </div>
      <ConfirmationDialog
        open={isOpen}
        onOpenChange={onOpenChange}
        title={options?.title || ''}
        description={options?.description || ''}
        confirmText={options?.confirmText}
        cancelText={options?.cancelText}
        variant={options?.variant}
        onConfirm={onConfirm}
      />
    </>
  );
}
