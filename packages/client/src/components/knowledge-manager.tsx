import type { UUID } from '@elizaos/core';
import { Book, Clock, File, FileText, LoaderIcon, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentMemories, useDeleteMemory } from '../hooks/use-query-hooks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardFooter, CardHeader } from './ui/card';

import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Memory } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

// Number of items to load per batch
const ITEMS_PER_PAGE = 10;

interface MemoryContent {
  text?: string;
  metadata?: {
    fileType?: string;
    title?: string;
    filename?: string;
    path?: string;
    description?: string;
  };
}

interface MemoryMetadata {
  type?: string;
  title?: string;
  filename?: string;
  path?: string;
  description?: string;
  fileExt?: string;
  timestamp?: number;
  contentType?: string;
  documentId?: string;
}

export function KnowledgeManager({ agentId }: { agentId: UUID }) {
  const [viewingContent, setViewingContent] = useState<Memory | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [visibleItems, setVisibleItems] = useState(ITEMS_PER_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Use 'documents' table for knowledge
  const tableName = 'documents';

  const { data: memories = [], isLoading, error } = useAgentMemories(agentId, tableName);
  const { mutate: deleteMemory } = useDeleteMemory();

  // Handle scroll to implement infinite loading
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current || loadingMore || visibleItems >= memories.length) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const scrolledToBottom = scrollTop + clientHeight >= scrollHeight - 100; // 100px buffer

    if (scrolledToBottom) {
      setLoadingMore(true);
      // Add a small delay to simulate loading and prevent too rapid updates
      setTimeout(() => {
        setVisibleItems((prev) => Math.min(prev + ITEMS_PER_PAGE, memories.length));
        setLoadingMore(false);
      }, 300);
    }
  }, [loadingMore, visibleItems, memories.length]);

  // Reset visible items when filter changes or new data loads
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

  if (isLoading && (!memories || memories.length === 0)) {
    return (
      <div className="flex items-center justify-center h-40">Loading knowledge documents...</div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-40 text-destructive">
        Error loading knowledge documents
      </div>
    );
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  };

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase();

    switch (ext) {
      case 'md':
        return <File className="h-4 w-4 text-blue-500" />;
      case 'js':
      case 'ts':
      case 'jsx':
      case 'tsx':
        return <File className="h-4 w-4 text-yellow-500" />;
      case 'json':
        return <File className="h-4 w-4 text-green-500" />;
      case 'pdf':
        return <FileText className="h-4 w-4 text-red-500" />;
      default:
        return <FileText className="h-4 w-4 text-gray-500" />;
    }
  };

  const handleDelete = (memoryId: string) => {
    if (memoryId && window.confirm('Are you sure you want to delete this document?')) {
      deleteMemory({ agentId, memoryId });
      setViewingContent(null);
    }
  };

  const handleUploadClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);

    try {
      const fileArray = Array.from(files);
      const result = await apiClient.uploadKnowledge(agentId, fileArray);

      if (result.success) {
        toast({
          title: 'Knowledge Uploaded',
          description: `Successfully uploaded ${fileArray.length} file(s)`,
        });

        queryClient.invalidateQueries({
          queryKey: ['agents', agentId, 'memories', 'documents'],
        });
      }
    } catch (error) {
      toast({
        title: 'Upload Failed',
        description: error instanceof Error ? error.message : 'Failed to upload knowledge files',
        variant: 'destructive',
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Get visible subset for infinite scrolling
  const visibleMemories = memories.slice(0, visibleItems);
  const hasMoreToLoad = visibleItems < memories.length;

  // Internal components for better organization
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
      <Book className="h-12 w-12 text-muted-foreground opacity-20" />
      <h3 className="text-lg font-medium">No Knowledge Documents</h3>
      <p className="max-w-md text-sm">No Knowledge Documents found.</p>
      <Button variant="outline" onClick={handleUploadClick}>
        <Upload className="h-4 w-4 mr-2" />
        Upload Documents
      </Button>
    </div>
  );

  const KnowledgeCard = ({ memory, index }: { memory: Memory; index: number }) => {
    const metadata = (memory.metadata as MemoryMetadata) || {};
    const title = metadata.title || memory.id || 'Unknown Document';
    const filename = metadata.filename || 'Unknown Document';
    const fileExt = metadata.fileExt || filename.split('.').pop()?.toLowerCase() || '';
    const displayName = title || filename;
    const subtitle = metadata.path || filename;

    return (
      <button
        key={memory.id || index}
        type="button"
        className="w-full text-left"
        onClick={() => setViewingContent(memory)}
      >
        <Card className="hover:bg-accent/10 transition-colors relative group">
          <div className="absolute top-3 left-3 opacity-70">{getFileIcon(filename)}</div>

          <CardHeader className="p-3 pb-2 pl-10">
            <div className="text-xs text-muted-foreground mb-1 line-clamp-1">{subtitle}</div>

            <div className="mb-2">
              <div className="text-sm font-medium mb-1">{displayName}</div>
              {metadata.description && (
                <div className="text-xs text-muted-foreground line-clamp-2">
                  {metadata.description}
                </div>
              )}
            </div>
          </CardHeader>

          <CardFooter className="p-2 border-t bg-muted/30 text-xs text-muted-foreground">
            <div className="flex justify-between items-center w-full">
              <div className="flex items-center">
                <Clock className="h-3 w-3 mr-1.5" />
                <span>
                  {new Date(memory.createdAt || 0).toLocaleString(undefined, {
                    month: 'numeric',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: 'numeric',
                  })}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Badge variant="outline" className="px-1.5 py-0 h-5">
                  {fileExt || 'unknown document'}
                </Badge>

                {memory.id && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      handleDelete(memory.id || '');
                    }}
                    title="Delete knowledge"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                )}
              </div>
            </div>
          </CardFooter>
        </Card>
      </button>
    );
  };

  // Render the content based on its type
  const renderDocumentContent = (memory: Memory) => {
    const metadata = (memory.metadata as MemoryMetadata) || {};
    const contentType = metadata.contentType;
    const fileExt = metadata.fileExt?.toLowerCase();

    // Handle PDF content specifically
    if (contentType === 'application/pdf' || fileExt === 'pdf') {
      // Check if content.text contains Base64 PDF data
      if (memory.content?.text && memory.content.text.startsWith('JVBER')) {
        // It's already Base64 encoded, we just need to add the data URL prefix
        const pdfData = `data:application/pdf;base64,${memory.content.text}`;
        return (
          <div className="w-full h-full">
            <iframe
              src={pdfData}
              className="w-full h-full border-0"
              title={metadata.title || 'PDF Document'}
            />
          </div>
        );
      }
    }

    // Default text rendering for non-PDF content
    return (
      <pre
        className={cn('text-sm whitespace-pre-wrap', {
          'font-mono':
            ((memory.content as MemoryContent)?.metadata?.fileType as string)?.includes(
              'application/'
            ) ||
            ((memory.content as MemoryContent)?.metadata?.fileType as string)?.includes(
              'text/plain'
            ),
          '':
            !((memory.content as MemoryContent)?.metadata?.fileType as string)?.includes(
              'application/'
            ) &&
            !((memory.content as MemoryContent)?.metadata?.fileType as string)?.includes(
              'text/plain'
            ),
        })}
      >
        {memory.content?.text}
      </pre>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
      <div className="flex justify-between items-center mb-4 px-4 pt-4 flex-none border-b pb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-medium">Knowledge Library</h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleUploadClick}
            disabled={isUploading}
            className="rounded-full"
            title="Upload documents"
          >
            <Upload className="h-4 w-4" />
            <span className="sr-only">{isUploading ? 'Uploading...' : 'Upload Documents'}</span>
          </Button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            multiple
            accept=".txt,.md,.js,.ts,.jsx,.tsx,.json,.csv,.html,.css,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          />
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-4 pb-4 h-[calc(100vh-60px)]"
      >
        {memories.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-4 w-full mx-auto">
            {visibleMemories.map((memory: Memory, index: number) => (
              <KnowledgeCard key={memory.id || index} memory={memory} index={index} />
            ))}
            {hasMoreToLoad && <LoadingIndicator />}
          </div>
        )}
      </div>

      {/* Knowledge content dialog */}
      <Dialog open={!!viewingContent} onOpenChange={(open) => !open && setViewingContent(null)}>
        <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
          <DialogHeader className="border-b pb-3">
            <DialogTitle className="flex items-center">
              {(() => {
                const metadata = (viewingContent?.metadata as MemoryMetadata) || {};
                const filename = metadata.filename || 'Unknown Document';
                const title = metadata.title || filename;

                return (
                  <>
                    {getFileIcon(filename)}
                    <span className="ml-2">{title}</span>
                  </>
                );
              })()}
            </DialogTitle>
            <DialogDescription className="flex items-center mt-1">
              <Clock className="h-3.5 w-3.5 mr-1" />
              Added on
              {viewingContent
                ? formatDate(viewingContent.createdAt || viewingContent.metadata?.timestamp || 0)
                : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto my-4 border rounded-md p-4 bg-muted">
            {viewingContent && renderDocumentContent(viewingContent)}
          </div>

          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => viewingContent?.id && handleDelete(viewingContent.id)}
              className="mr-auto"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>

            <Button onClick={() => setViewingContent(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
