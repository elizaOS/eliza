import React from 'react';
import type { UUID, Memory, Entity, Relationship } from '@elizaos/core';
import {
  Book,
  Clock,
  File,
  FileText,
  LoaderIcon,
  Trash2,
  Upload,
  List,
  Network,
  Users,
  Table as TableIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
// Define the metadata type locally since the types file doesn't exist
type MemoryMetadata = {
  title?: string;
  filename?: string;
  fileExt?: string;
  path?: string;
  description?: string;
  contentType?: string;
  type?: string;
  documentId?: string;
  position?: number;
  source?: string;
};

// Use local UI components instead of importing from client
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardFooter, CardHeader } from './card';
import { Input } from './input';
import { MemoryGraph } from './memory-graph';
import { EntityGraph } from './entity-graph';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

// Local utility function instead of importing from client
const cn = (...classes: (string | undefined | null | false)[]) => {
  return classes.filter(Boolean).join(' ');
};

// Temporary toast implementation
const useToast = () => ({
  toast: ({
    title,
    description,
    variant,
  }: {
    title: string;
    description: string;
    variant?: string;
  }) => {
    console.log(`Toast: ${title} - ${description} (${variant || 'default'})`);
    // TODO: Implement proper toast functionality
  },
});

// Simple Dialog components for now
const Dialog = ({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) => {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="bg-card text-card-foreground rounded-lg shadow-lg max-w-full max-h-full flex flex-col border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

const DialogContent = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => <div className={cn('p-6 flex flex-col border-border', className)}>{children}</div>;

const DialogHeader = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => <div className={cn('mb-4', className)}>{children}</div>;

const DialogTitle = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => <h2 className={cn('text-lg font-semibold', className)}>{children}</h2>;

const DialogDescription = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => <p className={cn('text-sm text-muted-foreground', className)}>{children}</p>;

const DialogFooter = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => <div className={cn('flex justify-end gap-2 mt-4', className)}>{children}</div>;

const ITEMS_PER_PAGE = 10;

interface UploadResultItem {
  status: string;
  id?: UUID;
  filename?: string;
}

// Helper function to get correct MIME type based on file extension
const getCorrectMimeType = (file: File): string => {
  const filename = file.name.toLowerCase();
  const ext = filename.split('.').pop() || '';

  // Map common text file extensions to text/plain
  const textExtensions = [
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'py',
    'pyw',
    'pyi',
    'java',
    'c',
    'cpp',
    'cc',
    'cxx',
    'h',
    'hpp',
    'cs',
    'php',
    'rb',
    'go',
    'rs',
    'swift',
    'kt',
    'kts',
    'scala',
    'clj',
    'cljs',
    'ex',
    'exs',
    'r',
    'R',
    'm',
    'mm',
    'sh',
    'bash',
    'zsh',
    'fish',
    'ps1',
    'bat',
    'cmd',
    'sql',
    'lua',
    'pl',
    'pm',
    'dart',
    'hs',
    'elm',
    'ml',
    'fs',
    'fsx',
    'vb',
    'pas',
    'd',
    'nim',
    'zig',
    'jl',
    'tcl',
    'awk',
    'sed',
    'vue',
    'svelte',
    'astro',
    'gitignore',
    'dockerignore',
    'editorconfig',
    'env',
    'cfg',
    'conf',
    'ini',
    'log',
    'txt',
  ];

  const markdownExtensions = ['md', 'markdown'];
  const jsonExtensions = ['json'];
  const xmlExtensions = ['xml'];
  const htmlExtensions = ['html', 'htm'];
  const cssExtensions = ['css', 'scss', 'sass', 'less'];
  const csvExtensions = ['csv', 'tsv'];
  const yamlExtensions = ['yaml', 'yml'];

  // Check extensions and return appropriate MIME type
  if (textExtensions.includes(ext)) {
    return 'text/plain';
  } else if (markdownExtensions.includes(ext)) {
    return 'text/markdown';
  } else if (jsonExtensions.includes(ext)) {
    return 'application/json';
  } else if (xmlExtensions.includes(ext)) {
    return 'application/xml';
  } else if (htmlExtensions.includes(ext)) {
    return 'text/html';
  } else if (cssExtensions.includes(ext)) {
    return 'text/css';
  } else if (csvExtensions.includes(ext)) {
    return 'text/csv';
  } else if (yamlExtensions.includes(ext)) {
    return 'text/yaml';
  } else if (ext === 'pdf') {
    return 'application/pdf';
  } else if (ext === 'doc') {
    return 'application/msword';
  } else if (ext === 'docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  // Return the original MIME type if not recognized
  return file.type || 'application/octet-stream';
};

const apiClient = {
  getKnowledgeDocuments: async (
    agentId: UUID,
    options?: { limit?: number; before?: number; includeEmbedding?: boolean }
  ) => {
    const params = new URLSearchParams();
    params.append('agentId', agentId);
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.before) params.append('before', options.before.toString());
    if (options?.includeEmbedding) params.append('includeEmbedding', 'true');

    const response = await fetch(`/api/documents?${params.toString()}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch knowledge documents: ${response.status} ${errorText}`);
    }
    return await response.json();
  },

  getEntities: async (agentId: UUID) => {
    const params = new URLSearchParams();
    params.append('agentId', agentId);
    
    const response = await fetch(`/api/entities?${params.toString()}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch entities: ${response.status} ${errorText}`);
    }
    return await response.json();
  },

  getRelationships: async (agentId: UUID) => {
    const params = new URLSearchParams();
    params.append('agentId', agentId);
    
    const response = await fetch(`/api/relationships?${params.toString()}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch relationships: ${response.status} ${errorText}`);
    }
    return await response.json();
  },

  getKnowledgeChunks: async (
    agentId: UUID,
    options?: { limit?: number; before?: number; documentId?: UUID }
  ) => {
    const params = new URLSearchParams();
    params.append('agentId', agentId);
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.before) params.append('before', options.before.toString());
    if (options?.documentId) params.append('documentId', options.documentId);

    const response = await fetch(`/api/knowledges?${params.toString()}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch knowledge chunks: ${response.status} ${errorText}`);
    }
    return await response.json();
  },

  deleteKnowledgeDocument: async (agentId: UUID, knowledgeId: UUID) => {
    const params = new URLSearchParams();
    params.append('agentId', agentId);

    const response = await fetch(`/api/documents/${knowledgeId}?${params.toString()}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete knowledge document: ${response.status} ${errorText}`);
    }
    if (response.status === 204) return;
    return await response.json();
  },

  uploadKnowledge: async (agentId: string, files: File[]) => {
    const formData = new FormData();
    for (const file of files) {
      // Create a new Blob with the correct MIME type
      const correctedMimeType = getCorrectMimeType(file);
      const blob = new Blob([file], { type: correctedMimeType });
      // Append as a file with the original name
      formData.append('files', blob, file.name);
    }
    formData.append('agentId', agentId);

    const response = await fetch(`/api/documents`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload knowledge: ${response.status} ${errorText}`);
    }
    return await response.json();
  },
};

const useKnowledgeDocuments = (
  agentId: UUID,
  enabled: boolean = true,
  includeEmbedding: boolean = false
) => {
  return useQuery<Memory[], Error>({
    queryKey: ['agents', agentId, 'knowledge', 'documents', { includeEmbedding }],
    queryFn: async () => {
      const response = await apiClient.getKnowledgeDocuments(agentId, { includeEmbedding });
      return response.data.memories || [];
    },
    enabled,
  });
};

const useEntities = (agentId: UUID, enabled: boolean = true) => {
  return useQuery<Entity[], Error>({
    queryKey: ['agents', agentId, 'entities'],
    queryFn: async () => {
      const response = await apiClient.getEntities(agentId);
      return response.data || [];
    },
    enabled,
  });
};

const useRelationships = (agentId: UUID, enabled: boolean = true) => {
  return useQuery<Relationship[], Error>({
    queryKey: ['agents', agentId, 'relationships'],
    queryFn: async () => {
      const response = await apiClient.getRelationships(agentId);
      return response.data || [];
    },
    enabled,
  });
};

const useKnowledgeChunks = (agentId: UUID, enabled: boolean = true, documentIdFilter?: UUID) => {
  // Query to get fragments (chunks)
  const {
    data: chunks = [],
    isLoading: chunksLoading,
    error: chunksError,
  } = useQuery<Memory[], Error>({
    queryKey: ['agents', agentId, 'knowledge', 'chunks', { documentIdFilter }],
    queryFn: async () => {
      const response = await apiClient.getKnowledgeChunks(agentId, {
        documentId: documentIdFilter,
      });
      return response.data.chunks || [];
    },
    enabled,
  });

  // Query to get documents
  const {
    data: documents = [],
    isLoading: documentsLoading,
    error: documentsError,
  } = useQuery<Memory[], Error>({
    queryKey: ['agents', agentId, 'knowledge', 'documents-for-graph'],
    queryFn: async () => {
      const response = await apiClient.getKnowledgeDocuments(agentId, { includeEmbedding: false });
      return response.data.memories || [];
    },
    enabled,
  });

  // Combine documents and fragments
  const allMemories = [...documents, ...chunks];
  const isLoading = chunksLoading || documentsLoading;
  const error = chunksError || documentsError;

  console.log(
    `Documents: ${documents.length}, Fragments: ${chunks.length}, Total: ${allMemories.length}`
  );

  return {
    data: allMemories,
    isLoading,
    error,
  };
};

// Hook for deleting knowledge documents
const useDeleteKnowledgeDocument = (agentId: UUID) => {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { knowledgeId: UUID }>({
    mutationFn: async ({ knowledgeId }) => {
      await apiClient.deleteKnowledgeDocument(agentId, knowledgeId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['agents', agentId, 'knowledge', 'documents'],
      });
    },
  });
};

export function RolodexTab({ agentId }: { agentId: UUID }) {
  const [viewingContent, setViewingContent] = useState<Memory | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [visibleItems, setVisibleItems] = useState(ITEMS_PER_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'graph' | 'entities' | 'entity-list'>('entity-list');
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
  const [documentIdFilter, setDocumentIdFilter] = useState<UUID | undefined>(undefined);
  const [pdfZoom, setPdfZoom] = useState(1.0);
  const [showUrlDialog, setShowUrlDialog] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [isUrlUploading, setIsUrlUploading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urls, setUrls] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // List mode: use useKnowledgeDocuments to get only documents
  const {
    data: documentsOnly = [],
    isLoading: documentsLoading,
    error: documentsError,
  } = useKnowledgeDocuments(agentId, viewMode === 'list', false);

  // Graph mode: use useKnowledgeChunks to get documents and fragments
  const {
    data: graphMemories = [],
    isLoading: graphLoading,
    error: graphError,
  } = useKnowledgeChunks(agentId, viewMode === 'graph', documentIdFilter);

  // Entity mode: get entities and relationships
  const {
    data: entities = [],
    isLoading: entitiesLoading,
    error: entitiesError,
  } = useEntities(agentId, viewMode === 'entities');

  const {
    data: relationships = [],
    isLoading: relationshipsLoading,
    error: relationshipsError,
  } = useRelationships(agentId, viewMode === 'entities');

  // Use the appropriate data based on the mode
  const isLoading = viewMode === 'list' ? documentsLoading : 
                   viewMode === 'graph' ? graphLoading : 
                   (entitiesLoading || relationshipsLoading);
  const error = viewMode === 'list' ? documentsError : 
                viewMode === 'graph' ? graphError : 
                (entitiesError || relationshipsError);
  const memories = viewMode === 'list' ? documentsOnly : graphMemories;

  const { mutate: deleteKnowledgeDoc } = useDeleteKnowledgeDocument(agentId);

  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current || loadingMore || visibleItems >= memories.length) {
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const scrolledToBottom = scrollTop + clientHeight >= scrollHeight - 100;
    if (scrolledToBottom) {
      setLoadingMore(true);
      setTimeout(() => {
        setVisibleItems((prev) => Math.min(prev + ITEMS_PER_PAGE, memories.length));
        setLoadingMore(false);
      }, 300);
    }
  }, [loadingMore, visibleItems, memories.length]);

  useEffect(() => {
    setVisibleItems(ITEMS_PER_PAGE);
  }, []);

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
        Error loading knowledge documents: {error.message}
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

  const handleDelete = (knowledgeId: string) => {
    if (knowledgeId && window.confirm('Are you sure you want to delete this document?')) {
      deleteKnowledgeDoc({ knowledgeId: knowledgeId as UUID });
      setViewingContent(null);
    }
  };

  const handleUploadClick = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const handleUrlUploadClick = () => {
    setShowUrlDialog(true);
    setUrlInput('');
    setUrls([]);
    setUrlError(null);
  };

  const addUrlToList = () => {
    try {
      const url = new URL(urlInput);
      if (!url.protocol.startsWith('http')) {
        setUrlError('URL must start with http:// or https://');
        return;
      }

      if (urls.includes(urlInput)) {
        setUrlError('This URL is already in the list');
        return;
      }

      setUrls([...urls, urlInput]);
      setUrlInput('');
      setUrlError(null);
    } catch (e) {
      setUrlError('Invalid URL');
    }
  };

  const removeUrl = (urlToRemove: string) => {
    setUrls(urls.filter((url) => url !== urlToRemove));
  };

  const handleUrlSubmit = async () => {
    // Check if there's a URL in the input field that hasn't been added to the list
    if (urlInput.trim()) {
      try {
        const url = new URL(urlInput);
        if (url.protocol.startsWith('http') && !urls.includes(urlInput)) {
          setUrls([...urls, urlInput]);
        }
      } catch (e) {
        // If the input is not a valid URL, just ignore it
      }
    }

    // If no URLs to process, show error
    if (urls.length === 0) {
      setUrlError('Please add at least one valid URL');
      return;
    }

    setIsUrlUploading(true);
    setUrlError(null);

    try {
      const result = await fetch(`/api/documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fileUrls: urls, agentId }),
      });

      if (!result.ok) {
        const error = await result.text();
        throw new Error(error);
      }

      const data = await result.json();

      if (data.success) {
        toast({
          title: 'URLs imported',
          description: `Successfully imported ${urls.length} document(s)`,
        });
        setShowUrlDialog(false);
        queryClient.invalidateQueries({
          queryKey: ['agents', agentId, 'knowledge', 'documents'],
        });
      } else {
        setUrlError(data.error?.message || 'Error importing documents from URLs');
      }
    } catch (error: any) {
      setUrlError(error.message || 'Error importing documents from URLs');
      toast({
        title: 'Error',
        description: 'Failed to import documents from URLs',
        variant: 'destructive',
      });
    } finally {
      setIsUrlUploading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      const fileArray = Array.from(files);
      // Use direct fetch instead of apiClient until it's updated
      const formData = new FormData();
      for (const file of fileArray) {
        // Create a new Blob with the correct MIME type
        const correctedMimeType = getCorrectMimeType(file);
        const blob = new Blob([file], { type: correctedMimeType });
        // Append as a file with the original name
        formData.append('files', blob, file.name);
      }
      formData.append('agentId', agentId);

      const response = await fetch('/api/documents', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const result = await response.json();

      // The actual array of upload outcomes is in result.data
      const uploadOutcomes: UploadResultItem[] = result.data || [];

      if (
        Array.isArray(uploadOutcomes) &&
        uploadOutcomes.every((r: UploadResultItem) => r.status === 'success')
      ) {
        toast({
          title: 'Knowledge Uploaded',
          description: `Successfully uploaded ${fileArray.length} file(s)`,
        });
        queryClient.invalidateQueries({
          queryKey: ['agents', agentId, 'knowledge', 'documents'],
        });
      } else {
        const successfulUploads = uploadOutcomes.filter(
          (r: UploadResultItem) => r.status === 'success'
        ).length;
        const failedUploads = fileArray.length - successfulUploads;
        toast({
          title: failedUploads > 0 ? 'Upload Partially Failed' : 'Upload Issues',
          description: `Uploaded ${successfulUploads} file(s). ${failedUploads} file(s) failed. Check console for details.`,
          variant: failedUploads > 0 ? 'destructive' : 'default',
        });
        console.error('Upload results:', uploadOutcomes);
      }
    } catch (uploadError: any) {
      toast({
        title: 'Upload Failed',
        description:
          uploadError instanceof Error ? uploadError.message : 'Failed to upload knowledge files',
        variant: 'destructive',
      });
      console.error('Upload error:', uploadError);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const visibleMemories = memories.slice(0, visibleItems);
  const hasMoreToLoad = visibleItems < memories.length;

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
        <Card className="hover:bg-accent/10 transition-colors relative group" data-testid="card">
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
                      if (e) {
                        e.stopPropagation();
                        e.preventDefault();
                      }
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

  // Add a function to handle the filtering of chunks by document
  const handleDocumentFilter = (docId?: UUID) => {
    setDocumentIdFilter(docId === documentIdFilter ? undefined : docId);
  };

  // Component to display the details of a fragment or document
  const MemoryDetails = ({ memory }: { memory: Memory }) => {
    const metadata = memory.metadata as MemoryMetadata;
    const isFragment = metadata?.type === 'fragment';
    const isDocument = metadata?.type === 'document';

    return (
      <div className="border-t border-border bg-card text-card-foreground h-full flex flex-col">
        <div className="p-4 flex justify-between items-start flex-shrink-0">
          <div className="space-y-1">
            <h3 className="text-sm font-medium flex items-center gap-2">
              {isFragment ? (
                <span className="flex items-center">
                  <div className="h-3 w-3 rounded-full bg-accent mr-1.5"></div>
                  Fragment
                </span>
              ) : (
                <span className="flex items-center">
                  <div className="h-3 w-3 rounded-full bg-primary mr-1.5"></div>
                  Document
                </span>
              )}
              <span className="text-muted-foreground ml-2">
                {metadata?.title || memory.id?.substring(0, 8)}
              </span>
            </h3>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <div className="col-span-2">
                ID: <span className="font-mono">{memory.id}</span>
              </div>

              {isFragment && metadata.documentId && (
                <div className="col-span-2">
                  Parent Document:{' '}
                  <span className="font-mono text-primary/80">{metadata.documentId}</span>
                </div>
              )}

              {isFragment && metadata.position !== undefined && (
                <div>Position: {metadata.position}</div>
              )}

              {metadata.source && <div>Source: {metadata.source}</div>}

              <div>Created on: {formatDate(memory.createdAt || 0)}</div>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedMemory(null)}
            className="text-xs h-7 px-2"
          >
            Close
          </Button>
        </div>

        <div className="px-4 pb-4 flex-1 flex flex-col">
          <div className="bg-background rounded border border-border p-3 text-sm overflow-auto flex-1">
            <pre className="whitespace-pre-wrap font-mono text-xs h-full">
              {memory.content?.text || 'No content available'}
            </pre>
          </div>

          {memory.embedding && (
            <div className="mt-2 flex items-center text-xs text-muted-foreground flex-shrink-0">
              <span className="bg-accent/20 text-accent-foreground px-1.5 py-0.5 rounded text-[10px] font-medium mr-1.5">
                EMBEDDING
              </span>
              <span>Vector with {memory.embedding.length} dimensions</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 border-b gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Knowledge</h2>
          <p className="text-xs text-muted-foreground">
            {viewMode === 'list'
              ? 'Viewing documents only'
              : viewMode === 'graph'
              ? 'Viewing documents and their fragments'
              : viewMode === 'entity-list'
              ? 'Viewing entities only'
              : 'Viewing entities and relationships'}
          </p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (viewMode === 'list') setViewMode('graph');
              else if (viewMode === 'graph') setViewMode('entities');
              else if (viewMode === 'entity-list') setViewMode('list');
              else setViewMode('entity-list');
            }}
            className="flex-shrink-0"
            title={
              viewMode === 'list'
                ? 'Switch to Graph view to see documents and fragments'
                : viewMode === 'graph'
                ? 'Switch to Entity Graph view to see relationships'
                : viewMode === 'entity-list'
                ? 'Switch to List view to see documents only'
                : 'Switch to Entity List view to see entities only'
            }
          >
            {viewMode === 'list' ? (
              <>
                <Network className="h-4 w-4 mr-2" />
                <span className="hidden md:inline">Graph View</span>
                <span className="md:hidden">Graph</span>
              </>
            ) : viewMode === 'graph' ? (
              <>
                <Users className="h-4 w-4 mr-2" />
                <span className="hidden md:inline">Entity Graph</span>
                <span className="md:hidden">Entities</span>
              </>
            ) : viewMode === 'entity-list' ? (
              <>
                <List className="h-4 w-4 mr-2" />
                <span className="hidden md:inline">List View</span>
                <span className="md:hidden">List</span>
              </>
            ) : (
              <>
                <Users className="h-4 w-4 mr-2" />
                <span className="hidden md:inline">Entity List</span>
                <span className="md:hidden">Entities</span>
              </>
            )}
          </Button>
          {viewMode === 'graph' && documentIdFilter && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDocumentIdFilter(undefined)}
              className="flex-shrink-0"
            >
              <span className="hidden sm:inline">Clear Filter</span>
              <span className="sm:hidden">Clear</span>
            </Button>
          )}
          <div className="flex gap-2 ml-auto sm:ml-0">
            <Button
              variant="outline"
              onClick={handleUrlUploadClick}
              size="sm"
              className="flex-shrink-0"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4 sm:mr-2"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
              </svg>
              <span className="hidden sm:inline">URL</span>
            </Button>
            <Button
              onClick={handleUploadClick}
              disabled={isUploading}
              size="sm"
              className="flex-shrink-0"
            >
              {isUploading ? (
                <LoaderIcon className="h-4 w-4 animate-spin sm:mr-2" />
              ) : (
                <Upload className="h-4 w-4 sm:mr-2" />
              )}
              <span className="hidden sm:inline">Upload</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Dialog for URL upload */}
      {showUrlDialog && (
        <Dialog open={showUrlDialog} onOpenChange={setShowUrlDialog}>
          <DialogContent className="max-w-md w-full">
            <DialogHeader>
              <DialogTitle className="text-xl font-bold">Import from URL</DialogTitle>
              <DialogDescription>
                Enter one or more URLs of PDF, text, or other files to import into the knowledge
                base.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-6 space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="https://example.com/document.pdf"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  disabled={isUrlUploading}
                  className="flex-1"
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter' && urlInput.trim()) {
                      e.preventDefault();
                      addUrlToList();
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addUrlToList}
                  disabled={isUrlUploading || !urlInput.trim()}
                >
                  Add
                </Button>
              </div>

              {urlError && (
                <div className="text-sm text-destructive bg-destructive/10 p-2 rounded-md">
                  {urlError}
                </div>
              )}

              {urls.length > 0 && (
                <div className="border border-border rounded-md bg-card/50 p-3 mt-2">
                  <h4 className="text-sm font-medium mb-2">URLs to import ({urls.length})</h4>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {urls.map((url, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between text-sm bg-background p-2 rounded border border-border"
                      >
                        <span className="truncate flex-1">{url}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => removeUrl(url)}
                          disabled={isUrlUploading}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="mt-6 pt-4 border-t border-border">
              <Button
                variant="outline"
                onClick={() => setShowUrlDialog(false)}
                disabled={isUrlUploading}
              >
                Cancel
              </Button>
              <Button
                onClick={handleUrlSubmit}
                disabled={isUrlUploading || (urls.length === 0 && !urlInput.trim())}
              >
                {isUrlUploading ? (
                  <>
                    <LoaderIcon className="h-4 w-4 animate-spin mr-2" />
                    Importing...
                  </>
                ) : (
                  'Import'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Existing input for file upload */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".txt,.md,.markdown,.pdf,.doc,.docx,.json,.xml,.yaml,.yml,.csv,.tsv,.log,.ini,.cfg,.conf,.env,.gitignore,.dockerignore,.editorconfig,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.pyw,.pyi,.java,.c,.cpp,.cc,.cxx,.h,.hpp,.cs,.php,.rb,.go,.rs,.swift,.kt,.kts,.scala,.clj,.cljs,.ex,.exs,.r,.R,.m,.mm,.sh,.bash,.zsh,.fish,.ps1,.bat,.cmd,.sql,.html,.htm,.css,.scss,.sass,.less,.vue,.svelte,.astro,.lua,.pl,.pm,.dart,.hs,.elm,.ml,.fs,.fsx,.vb,.pas,.d,.nim,.zig,.jl,.tcl,.awk,.sed"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className="flex-1 overflow-hidden">
        {viewMode === 'entities' ? (
          <div className="flex flex-col h-full">
            {entities.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p className="text-lg font-medium">No entities found</p>
                  <p className="text-sm">Entities will appear here as they are mentioned in conversations</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 p-4">
                <EntityGraph
                  entities={entities}
                  relationships={relationships}
                  onNodeClick={setSelectedEntity}
                  selectedEntityId={selectedEntity?.id}
                />
              </div>
            )}
            {selectedEntity && (
              <div className="h-1/3 border-t bg-card p-4 overflow-auto">
                <h3 className="font-medium mb-2">{selectedEntity.names[0]}</h3>
                <div className="text-sm text-muted-foreground space-y-1">
                  <div>ID: {selectedEntity.id}</div>
                  {(() => {
                    const platformIds = selectedEntity.metadata?.platformIdentities;
                    if (platformIds && Array.isArray(platformIds) && platformIds.length > 0) {
                      const platforms = platformIds
                        .map((p: any) => `${p.platform}: ${p.handle}`)
                        .join(', ');
                      return <div>Platforms: {platforms}</div>;
                    }
                    return null;
                  })()}
                  {(() => {
                    const trust = selectedEntity.metadata?.trustMetrics;
                    if (trust && typeof trust === 'object' && 
                        'helpfulness' in trust && 'suspicionLevel' in trust) {
                      const trustLevel = ((trust as any).helpfulness - 
                        (trust as any).suspicionLevel).toFixed(2);
                      return <div>Trust Level: {trustLevel}</div>;
                    }
                    return null;
                  })()}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setSelectedEntity(null)}
                >
                  Close
                </Button>
              </div>
            )}
          </div>
        ) : viewMode === 'entity-list' ? (
          <div className="h-full overflow-auto p-4">
            {entities.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p className="text-lg font-medium">No entities found</p>
                  <p className="text-sm">Entities will appear here as they are mentioned in conversations</p>
                </div>
              </div>
            ) : (
              <div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Platform Identities</TableHead>
                      <TableHead>Trust Level</TableHead>
                      <TableHead>Relationships</TableHead>
                      <TableHead>Metadata</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entities.map((entity) => {
                      const platformIds = entity.metadata?.platformIdentities as any[] || [];
                      const trust = entity.metadata?.trustMetrics as any;
                      const trustLevel = trust && 'helpfulness' in trust && 'suspicionLevel' in trust
                        ? (trust.helpfulness - trust.suspicionLevel).toFixed(2)
                        : 'N/A';
                      
                      const entityRelationships = relationships.filter(
                        r => r.sourceEntityId === entity.id || r.targetEntityId === entity.id
                      );
                      
                      // Extract other metadata
                      const otherMetadata = { ...entity.metadata };
                      delete otherMetadata.platformIdentities;
                      delete otherMetadata.trustMetrics;

                      return (
                        <TableRow key={entity.id} className="cursor-pointer hover:bg-accent/50">
                          <TableCell className="font-medium">
                            <div>
                              <div>{entity.names[0]}</div>
                              {entity.names.length > 1 && (
                                <div className="text-xs text-muted-foreground">
                                  aka: {entity.names.slice(1).join(', ')}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {platformIds.length > 0 ? (
                              <div className="space-y-1">
                                {platformIds.map((p, idx) => (
                                  <div key={idx} className="flex items-center gap-1 text-xs">
                                    <Badge variant="outline" className="px-1.5 py-0">
                                      {p.platform}
                                    </Badge>
                                    <span className="font-mono">{p.handle}</span>
                                    {p.verified && (
                                      <span className="text-green-600 dark:text-green-400">✓</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs">None</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {trust ? (
                              <div className="space-y-1">
                                <div className={cn(
                                  "font-medium",
                                  Number(trustLevel) > 0.5 ? 'text-green-600 dark:text-green-400' :
                                  Number(trustLevel) < -0.5 ? 'text-red-600 dark:text-red-400' :
                                  'text-yellow-600 dark:text-yellow-400'
                                )}>
                                  {trustLevel}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  H: {trust.helpfulness.toFixed(2)} / S: {trust.suspicionLevel.toFixed(2)}
                                </div>
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs">N/A</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="text-xs">
                              {entityRelationships.length > 0 ? (
                                <div>
                                  {entityRelationships.slice(0, 3).map((rel, idx) => {
                                    const otherEntityId = rel.sourceEntityId === entity.id 
                                      ? rel.targetEntityId 
                                      : rel.sourceEntityId;
                                    const otherEntity = entities.find(e => e.id === otherEntityId);
                                    return (
                                      <div key={idx} className="truncate">
                                        {otherEntity?.names[0] || 'Unknown'}
                                        {rel.metadata?.relationshipType ? (
                                          <span className="text-muted-foreground"> ({String(rel.metadata.relationshipType)})</span>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                  {entityRelationships.length > 3 && (
                                    <div className="text-muted-foreground">
                                      +{entityRelationships.length - 3} more
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">None</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-xs font-mono max-w-xs">
                              {Object.keys(otherMetadata).length > 0 ? (
                                <details>
                                  <summary className="cursor-pointer">
                                    {Object.keys(otherMetadata).length} fields
                                  </summary>
                                  <div className="mt-1 whitespace-pre-wrap text-[10px]">
                                    {JSON.stringify(otherMetadata, null, 2)}
                                  </div>
                                </details>
                              ) : (
                                <span className="text-muted-foreground">None</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        ) : memories.length === 0 ? (
          <EmptyState />
        ) : viewMode === 'graph' ? (
          <div className="flex flex-col h-full">
            <div
              className={`p-4 overflow-hidden ${selectedMemory ? 'h-1/3' : 'flex-1'} transition-all duration-300`}
            >
              <MemoryGraph
                memories={memories}
                onNodeClick={(memory) => {
                  setSelectedMemory(memory);
                  // If this is a document, filter to show only its chunks
                  if (
                    memory.metadata &&
                    typeof memory.metadata === 'object' &&
                    'type' in memory.metadata &&
                    (memory.metadata.type || '').toLowerCase() === 'document' &&
                    !('documentId' in memory.metadata)
                  ) {
                    handleDocumentFilter(memory.id as UUID);
                  }
                }}
                selectedMemoryId={selectedMemory?.id}
              />
              {documentIdFilter && (
                <div className="absolute top-16 left-4 bg-card/90 backdrop-blur-sm text-card-foreground p-2 rounded-md shadow-sm border border-border">
                  <span className="text-xs text-muted-foreground flex items-center">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-3 w-3 mr-1.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                    </svg>
                    Filtering by document ID:{' '}
                    <span className="font-mono ml-1">{documentIdFilter.substring(0, 8)}...</span>
                  </span>
                </div>
              )}
            </div>

            {/* Display details of selected node */}
            {selectedMemory && (
              <div className="h-2/3 overflow-hidden flex-1 transition-all duration-300">
                <MemoryDetails memory={selectedMemory} />
              </div>
            )}
          </div>
        ) : (
          <div ref={scrollContainerRef} className="h-full overflow-y-auto p-4">
            <div className="grid gap-3">
              {visibleMemories.map((memory, index) => (
                <KnowledgeCard key={memory.id || index} memory={memory} index={index} />
              ))}
            </div>
            {hasMoreToLoad && <LoadingIndicator />}
          </div>
        )}
      </div>

      {viewingContent && (
        <Dialog open={!!viewingContent} onOpenChange={() => setViewingContent(null)}>
          <DialogContent className="max-w-[95vw] w-full max-h-[95vh] h-full overflow-hidden flex flex-col p-0">
            <DialogHeader className="flex-shrink-0 p-6 pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <DialogTitle className="text-xl">
                    {(viewingContent.metadata as MemoryMetadata)?.title || 'Document Content'}
                  </DialogTitle>
                  <DialogDescription>
                    {(viewingContent.metadata as MemoryMetadata)?.filename || 'Knowledge document'}
                  </DialogDescription>
                </div>
                {(() => {
                  const metadata = viewingContent.metadata as MemoryMetadata;
                  const contentType = metadata?.contentType || '';
                  const fileExt = metadata?.fileExt?.toLowerCase() || '';
                  const isPdf = contentType === 'application/pdf' || fileExt === 'pdf';

                  if (isPdf) {
                    return (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPdfZoom(Math.max(0.5, pdfZoom - 0.25))}
                          disabled={pdfZoom <= 0.5}
                        >
                          <span className="text-lg">−</span>
                        </Button>
                        <span className="text-sm font-medium min-w-[60px] text-center">
                          {Math.round(pdfZoom * 100)}%
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPdfZoom(Math.min(3, pdfZoom + 0.25))}
                          disabled={pdfZoom >= 3}
                        >
                          <span className="text-lg">+</span>
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPdfZoom(1.0)}>
                          Reset
                        </Button>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            </DialogHeader>
            <div className="flex-1 overflow-auto px-6 pb-2">
              {(() => {
                const metadata = viewingContent.metadata as MemoryMetadata;
                const contentType = metadata?.contentType || '';
                const fileExt = metadata?.fileExt?.toLowerCase() || '';
                const isPdf = contentType === 'application/pdf' || fileExt === 'pdf';

                if (isPdf && viewingContent.content?.text) {
                  // For PDFs, the content.text contains base64 data
                  // Validate base64 content before creating data URL
                  const base64Content = viewingContent.content.text.trim();

                  if (!base64Content) {
                    // Show error message if no content available
                    return (
                      <div className="h-full w-full bg-background rounded-lg border border-border p-6 flex items-center justify-center">
                        <div className="text-center text-muted-foreground">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-12 w-12 mx-auto mb-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.314 18.5c-.77.833.192 2.5 1.732 2.5z"
                            />
                          </svg>
                          <p className="text-lg font-medium">PDF Content Unavailable</p>
                          <p className="text-sm">The PDF content could not be loaded.</p>
                        </div>
                      </div>
                    );
                  }

                  // Create a data URL for the PDF
                  const pdfDataUrl = `data:application/pdf;base64,${base64Content}`;

                  return (
                    <div className="w-full h-full rounded-lg overflow-auto bg-card border border-border">
                      <div
                        className="min-w-full flex items-center justify-center p-4"
                        style={{
                          minHeight: '100%',
                          transform: `scale(${pdfZoom})`,
                          transformOrigin: 'top center',
                          width: pdfZoom > 1 ? `${100 / pdfZoom}%` : '100%',
                        }}
                      >
                        <iframe
                          src={pdfDataUrl}
                          className="w-full border-0 shadow-md"
                          style={{
                            height: '90vh',
                            maxWidth: '1200px',
                            backgroundColor: 'var(--background)',
                          }}
                          title="PDF Document"
                          onError={() => {
                            console.error('Failed to load PDF in iframe');
                          }}
                        />
                      </div>
                    </div>
                  );
                } else if (isPdf && !viewingContent.content?.text) {
                  // Show error message for PDFs without content
                  return (
                    <div className="h-full w-full bg-background rounded-lg border border-border p-6 flex items-center justify-center">
                      <div className="text-center text-muted-foreground">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-12 w-12 mx-auto mb-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        <p className="text-lg font-medium">PDF Not Available</p>
                        <p className="text-sm">This PDF document has no content to display.</p>
                      </div>
                    </div>
                  );
                } else {
                  // For all other documents, display as plain text
                  return (
                    <div className="h-full w-full bg-background rounded-lg border border-border p-6">
                      <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed text-foreground">
                        {viewingContent.content?.text || 'No content available'}
                      </pre>
                    </div>
                  );
                }
              })()}
            </div>
            <DialogFooter className="flex-shrink-0 p-6 pt-4 border-t border-border">
              <Button
                variant="outline"
                onClick={() => {
                  setViewingContent(null);
                  setPdfZoom(1.0); // Reset zoom when closing
                }}
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
