import type { Memory, UUID } from '@elizaos/core';
import { Database, LoaderIcon, Pencil, Search, Brain, User, Bot, Clock, Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentMemories, useAgents } from '@/hooks/use-query-hooks';
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
import MemoryEditOverlay from './agent-memory-edit-overlay';

// Number of items to load per batch
const ITEMS_PER_PAGE = 15;

interface MemoryContent {
  thought?: boolean | string;
  channelType?: string;
  source?: string;
  text?: string;
  metadata?: {
    fileType?: string;
    title?: string;
    filename?: string;
    path?: string;
    description?: string;
  };
}

interface ChatMemoryContent extends MemoryContent {
  text?: string;
  actions?: string[];
  thought?: boolean | string;
  inReplyTo?: string;
  providers?: string[];
  channelType?: string;
}

enum MemoryType {
  all = 'all',
  currentChat = 'currentChat',
  messagesReceived = 'messagesReceived',
  messagesSent = 'messagesSent',
  facts = 'facts',
}

interface AgentMemoryViewerProps {
  agentId: UUID;
  agentName: string;
  channelId?: UUID; // Renamed from roomId to channelId for clarity
}

export function AgentMemoryViewer({ agentId, agentName, channelId }: AgentMemoryViewerProps) {
  const [selectedType, setSelectedType] = useState<MemoryType>(MemoryType.all);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [visibleItems, setVisibleItems] = useState(ITEMS_PER_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Get all agents to look up names by ID
  const { data: agentsData } = useAgents();

  // Fetch from appropriate table(s) based on selected type
  const messagesTableName = selectedType === MemoryType.facts ? undefined : 'messages';
  const factsTableName =
    selectedType === MemoryType.facts || selectedType === MemoryType.all ? 'facts' : undefined;

  // Only pass channelId when "Current Chat" is selected
  const channelIdToUse =
    selectedType === MemoryType.currentChat && channelId ? channelId : undefined;

  const {
    data: messagesData = [],
    isLoading: isLoadingMessages,
    error: messagesError,
  } = useAgentMemories(agentId, messagesTableName, channelIdToUse);
  const {
    data: factsData = [],
    isLoading: isLoadingFacts,
    error: factsError,
  } = useAgentMemories(agentId, factsTableName, channelIdToUse);

  // Combine memories from both sources
  const memories = [...messagesData, ...factsData];
  const isLoading = isLoadingMessages || isLoadingFacts;
  const error = messagesError || factsError;

  // Filter and search memories
  const filteredMemories = memories.filter((memory: Memory) => {
    // Type filter
    if (selectedType !== MemoryType.all && selectedType !== MemoryType.currentChat) {
      // Facts are handled by table selection, so if we're on facts table, show all
      if (selectedType === MemoryType.facts) {
        return true; // Already filtered by table
      }

      // For messages table, filter by type
      if (selectedType === MemoryType.messagesSent && memory.entityId !== memory.agentId)
        return false;
      if (selectedType === MemoryType.messagesReceived && memory.entityId === memory.agentId)
        return false;
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const content = memory.content as ChatMemoryContent;
      const searchableText = [content?.text, content?.thought, memory.id, memory.metadata]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchableText.includes(query);
    }

    return true;
  });

  // Handle scroll for infinite loading
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current || loadingMore || visibleItems >= filteredMemories.length) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const scrolledToBottom = scrollTop + clientHeight >= scrollHeight - 200;

    if (scrolledToBottom) {
      setLoadingMore(true);
      setTimeout(() => {
        setVisibleItems((prev) => Math.min(prev + ITEMS_PER_PAGE, filteredMemories.length));
        setLoadingMore(false);
      }, 500);
    }
  }, [loadingMore, visibleItems, filteredMemories.length]);

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

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffInHours < 24) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffInHours < 168) {
      // 7 days
      return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  };

  const getMemoryIcon = (memory: Memory, content: ChatMemoryContent) => {
    if (content?.thought) return Brain;
    if (memory.entityId === memory.agentId) return Bot;
    return User;
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  // Group messages by date
  const groupMessagesByDate = (messages: Memory[]) => {
    const groups: Record<string, Memory[]> = {};

    for (const memory of messages) {
      const date = new Date(memory.createdAt || 0);
      const dateKey = date.toLocaleDateString();

      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(memory);
    }

    return groups;
  };

  const visibleMemories = filteredMemories.slice(0, visibleItems);
  const hasMoreToLoad = visibleItems < filteredMemories.length;
  const messageGroups = groupMessagesByDate(visibleMemories);

  // Loading state
  if (isLoading && memories.length === 0) {
    return (
      <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
        <div className="flex items-center justify-center flex-1">
          <div className="flex flex-col items-center gap-4">
            <LoaderIcon className="h-8 w-8 animate-spin text-muted-foreground" />
            <div className="text-center">
              <h3 className="font-medium">Loading Memories</h3>
              <p className="text-sm text-muted-foreground">
                Fetching agent conversation history...
              </p>
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
            <h3 className="font-medium text-destructive">Failed to Load Memories</h3>
            <p className="text-sm text-muted-foreground">
              There was an error loading the agent memories.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Empty state
  const EmptyState = () => (
    <div className="flex flex-col items-center justify-center flex-1 text-center p-8">
      <Database className="h-16 w-16 text-muted-foreground/30 mb-4" />
      <h3 className="text-lg font-medium mb-2">No Memories Found</h3>
      <p className="text-muted-foreground max-w-md mb-4">
        {searchQuery
          ? `No memories match "${searchQuery}". Try adjusting your search or filter.`
          : "This agent hasn't created any memories yet. Memories will appear here as the agent interacts."}
      </p>
      {searchQuery && (
        <Button variant="outline" onClick={() => setSearchQuery('')}>
          Clear Search
        </Button>
      )}
    </div>
  );

  // Memory card component
  const MemoryCard = ({ memory }: { memory: Memory }) => {
    const content = memory.content as ChatMemoryContent;
    const IconComponent = getMemoryIcon(memory, content);
    const isAgent = memory.entityId === memory.agentId;

    // Look up entity name from agents data or fallback to metadata
    const getEntityName = () => {
      if (isAgent) {
        // For agents, try to find the agent name by ID
        const agent = agentsData?.data?.agents?.find((a) => a.id === memory.entityId);
        return agent?.name || agentName;
      } else {
        // For users, use raw metadata or fallback
        return (memory.metadata as any)?.raw?.senderName || memory.metadata?.source || 'User';
      }
    };

    const entityName = getEntityName();

    return (
      <div className="border rounded-lg p-4 bg-card hover:bg-accent/5 transition-colors group">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-muted">
              <IconComponent className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{entityName}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                  {content?.thought ? 'Thought' : isAgent ? 'Agent' : 'User'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                <Clock className="h-3 w-3" />
                <span>{formatDate(memory.createdAt || 0)}</span>
                {memory.id && (
                  <>
                    <span>•</span>
                    <code className="text-[10px] bg-muted px-1 rounded">{memory.id.slice(-8)}</code>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {content?.text && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(content.text || '')}
                className="h-8 w-8 p-0"
                title="Copy text"
              >
                <Copy className="h-3 w-3" />
              </Button>
            )}
            {memory.id && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingMemory(memory)}
                className="h-8 w-8 p-0"
                title="Edit memory"
              >
                <Pencil className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="space-y-3">
          {/* Main text */}
          {content?.text && (
            <div className="bg-muted/50 rounded-md p-3">
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{content.text}</p>
            </div>
          )}

          {/* Thought process */}
          {content?.thought && (
            <div className="border-l-2 border-muted pl-3">
              <div className="flex items-center gap-2 mb-1">
                <Brain className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Thought Process</span>
              </div>
              <p className="text-xs text-muted-foreground italic leading-relaxed">
                {String(content.thought)}
              </p>
            </div>
          )}

          {/* Tags */}
          {(content?.actions || content?.providers || content?.source) && (
            <div className="flex flex-wrap gap-1">
              {content.actions?.map((action) => (
                <span
                  key={action}
                  className="text-xs px-2 py-1 bg-muted rounded text-muted-foreground"
                  title="Action"
                >
                  {action}
                </span>
              ))}
              {content.providers?.map((provider) => (
                <span
                  key={provider}
                  className="text-xs px-2 py-1 bg-muted rounded text-muted-foreground"
                  title="Provider"
                >
                  {provider}
                </span>
              ))}
              {content.source && (
                <span className="text-xs px-2 py-1 bg-muted rounded text-muted-foreground">
                  {content.source}
                </span>
              )}
            </div>
          )}

          {/* Metadata (simplified) */}
          {memory.metadata && Object.keys(memory.metadata).length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                View metadata
              </summary>
              <div className="mt-2 p-2 bg-muted/30 rounded text-[10px] font-mono overflow-x-auto">
                <pre>{JSON.stringify(memory.metadata, null, 2)}</pre>
              </div>
            </details>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
      {/* Header */}
      <div className="flex justify-between items-center mb-4 px-4 pt-4 flex-none border-b pb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-medium">Memories</h3>
          {!isLoading && (
            <span className="ml-2 text-xs px-2 py-1 rounded bg-muted text-muted-foreground">
              {filteredMemories.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search memories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 w-full min-w-0 max-w-64"
            />
          </div>
          {/* Type Filter */}
          <Select
            value={selectedType}
            onValueChange={(value) => setSelectedType(value as MemoryType)}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Filter memories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MemoryType.all}>All Messages</SelectItem>
              {channelId && <SelectItem value={MemoryType.currentChat}>Current Chat</SelectItem>}
              <SelectItem value={MemoryType.messagesSent}>Agent Messages</SelectItem>
              <SelectItem value={MemoryType.messagesReceived}>User Messages</SelectItem>
              <SelectItem value={MemoryType.facts}>Facts</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4">
        {filteredMemories.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {Object.entries(messageGroups).map(([date, messages]) => (
              <div key={date} className="space-y-3">
                <div className="flex items-center gap-3 py-2">
                  <Separator className="flex-1" />
                  <span className="text-sm font-medium text-muted-foreground px-2">{date}</span>
                  <Separator className="flex-1" />
                </div>
                <div className="space-y-3">
                  {messages.map((memory) => (
                    <MemoryCard key={memory.id || memory.createdAt} memory={memory} />
                  ))}
                </div>
              </div>
            ))}

            {/* Load more */}
            {hasMoreToLoad && (
              <div className="flex justify-center py-6">
                {loadingMore ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <LoaderIcon className="h-4 w-4 animate-spin" />
                    <span className="text-sm">Loading more memories...</span>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => setVisibleItems((prev) => prev + ITEMS_PER_PAGE)}
                    className="px-8"
                  >
                    Load More
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit overlay */}
      {editingMemory && (
        <MemoryEditOverlay
          isOpen={!!editingMemory}
          onClose={() => setEditingMemory(null)}
          memory={editingMemory}
          agentId={agentId}
        />
      )}
    </div>
  );
}
