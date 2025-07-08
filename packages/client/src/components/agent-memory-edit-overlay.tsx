import type React from 'react';
import { useUpdateMemory, useDeleteMemory } from '@/hooks/use-query-hooks';
import type { Memory, UUID } from '@elizaos/core';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Trash, X, Save, AlertTriangle, Check, RotateCcw, Copy, Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useConfirmation } from '@/hooks/use-confirmation';
import ConfirmationDialog from './confirmation-dialog';

interface MemoryEditOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  memory: Memory;
  agentId: UUID;
}

export default function MemoryEditOverlay({
  isOpen,
  onClose,
  memory,
  agentId,
}: MemoryEditOverlayProps) {
  const { toast } = useToast();
  const { mutate: updateMemory, isPending: isUpdating } = useUpdateMemory();
  const { mutate: deleteMemory, isPending: isDeleting } = useDeleteMemory();

  const [editedContent, setEditedContent] = useState('');
  const [isValidJson, setIsValidJson] = useState(true);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isProcessing = isUpdating || isDeleting;
  const originalContent = JSON.stringify(memory.content, null, 2);

  const { confirm, isOpen: confirmOpen, onOpenChange, onConfirm, options } = useConfirmation();

  // Initialize content when component opens
  useEffect(() => {
    if (isOpen) {
      setEditedContent(originalContent);
      setIsValidJson(true);
      setHasUnsavedChanges(false);
      setIsPreviewMode(false);
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    }
  }, [isOpen, originalContent]);

  // Check for unsaved changes
  useEffect(() => {
    setHasUnsavedChanges(editedContent !== originalContent);
  }, [editedContent, originalContent]);

  // Validate JSON on content change
  useEffect(() => {
    if (!editedContent.trim()) {
      setIsValidJson(false);
      return;
    }

    try {
      JSON.parse(editedContent);
      setIsValidJson(true);
    } catch {
      setIsValidJson(false);
    }
  }, [editedContent]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        if (hasUnsavedChanges) {
          confirm(
            {
              title: 'Discard Unsaved Changes?',
              description:
                'You have unsaved changes. Are you sure you want to close without saving?',
              confirmText: 'Discard',
              variant: 'destructive',
            },
            () => {
              onClose();
            }
          );
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, hasUnsavedChanges, onClose]);

  const handleSave = useCallback(() => {
    if (!editedContent.trim()) {
      toast({
        title: 'Error',
        description: 'Memory content cannot be empty',
        variant: 'destructive',
      });
      return;
    }

    if (!isValidJson) {
      toast({
        title: 'Invalid JSON',
        description: 'Please fix JSON syntax errors before saving',
        variant: 'destructive',
      });
      return;
    }

    try {
      const parsedContent = JSON.parse(editedContent);

      updateMemory(
        {
          agentId,
          memoryId: memory.id!,
          memoryData: {
            content: parsedContent,
          },
        },
        {
          onSuccess: () => {
            onClose();
            toast({
              title: 'Memory Updated',
              description: 'The memory content has been successfully updated',
            });
          },
          onError: (error) => {
            toast({
              title: 'Update Failed',
              description: error.message || 'Failed to update memory',
              variant: 'destructive',
            });
          },
        }
      );
    } catch (error) {
      toast({
        title: 'Invalid JSON',
        description: 'Please enter valid JSON format',
        variant: 'destructive',
      });
    }
  }, [editedContent, isValidJson, updateMemory, agentId, memory.id, onClose, toast]);

  const handleDelete = useCallback(() => {
    confirm(
      {
        title: 'Delete Memory',
        description: 'Are you sure you want to delete this memory? This action cannot be undone.',
        confirmText: 'Delete',
        variant: 'destructive',
      },
      () => {
        deleteMemory(
          {
            agentId,
            memoryId: memory.id!,
          },
          {
            onSuccess: () => {
              onClose();
              toast({
                title: 'Memory Deleted',
                description: 'The memory has been successfully removed',
              });
            },
            onError: (error) => {
              toast({
                title: 'Delete Failed',
                description: error.message || 'Failed to delete memory',
                variant: 'destructive',
              });
            },
          }
        );
      }
    );
  }, [deleteMemory, agentId, memory.id, onClose, toast]);

  const handlePrettyFormat = useCallback(() => {
    try {
      const parsed = JSON.parse(editedContent);
      setEditedContent(JSON.stringify(parsed, null, 2));
      toast({
        title: 'Formatted',
        description: 'JSON has been formatted',
      });
    } catch (error) {
      toast({
        title: 'Format Error',
        description: 'Cannot format invalid JSON',
        variant: 'destructive',
      });
    }
  }, [editedContent, toast]);

  const handleReset = useCallback(() => {
    confirm(
      {
        title: 'Reset Changes',
        description: 'Reset to original content? All unsaved changes will be lost.',
        confirmText: 'Reset',
        variant: 'destructive',
      },
      () => {
        setEditedContent(originalContent);
      }
    );
  }, [originalContent]);

  const handleCopyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(editedContent);
      toast({
        title: 'Copied',
        description: 'Content copied to clipboard',
      });
    } catch (error) {
      toast({
        title: 'Copy Failed',
        description: 'Failed to copy to clipboard',
        variant: 'destructive',
      });
    }
  }, [editedContent, toast]);

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      if (hasUnsavedChanges) {
        confirm(
          {
            title: 'Discard Unsaved Changes?',
            description: 'You have unsaved changes. Are you sure you want to close without saving?',
            confirmText: 'Discard',
            variant: 'destructive',
          },
          () => {
            onClose();
          }
        );
      } else {
        onClose();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
        onClick={handleOverlayClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-edit-title"
      >
        <Card
          className="w-full max-w-4xl h-[85vh] max-h-[800px] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 flex-shrink-0">
            <div className="flex items-center gap-2">
              <CardTitle id="memory-edit-title" className="text-xl font-semibold">
                Edit Memory Content
              </CardTitle>
              {hasUnsavedChanges && (
                <span className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                  Unsaved changes
                </span>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>

          <Separator />

          <CardContent className="pt-4 flex-1 overflow-hidden flex flex-col">
            {/* Warning Banner */}
            <div className="mb-4 flex items-start bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded-md p-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mr-2 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-800 dark:text-amber-200">
                <p className="font-medium mb-1">Editing Raw Memory Content</p>
                <p>Changes may affect agent behavior. Ensure JSON format is valid before saving.</p>
              </div>
            </div>

            {/* Memory Metadata */}
            <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">ID:</span>
                  <code className="text-xs bg-muted px-1 rounded">{memory.id}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Created:</span>
                  <span>{formatTimestamp(memory.createdAt || 0)}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Room:</span>
                  <code className="text-xs bg-muted px-1 rounded">{memory.roomId}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Type:</span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      memory.entityId === agentId
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                        : 'bg-white-100 text-white dark:bg-white-800 dark:text-white'
                    }`}
                  >
                    {memory.entityId === agentId ? 'Agent Message' : 'User Message'}
                  </span>
                </div>
              </div>
            </div>

            {/* Editor Controls */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <label htmlFor="memory-content" className="text-sm font-medium">
                  Memory Content
                </label>
                <div className="flex items-center gap-1">
                  {isValidJson ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <AlertTriangle className="h-3 w-3 text-red-500" />
                  )}
                  <span className={`text-xs ${isValidJson ? 'text-green-600' : 'text-red-600'}`}>
                    {isValidJson ? 'Valid JSON' : 'Invalid JSON'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsPreviewMode(!isPreviewMode)}
                  disabled={isProcessing}
                  title={isPreviewMode ? 'Switch to edit mode' : 'Switch to preview mode'}
                >
                  {isPreviewMode ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyToClipboard}
                  disabled={isProcessing}
                  title="Copy to clipboard"
                >
                  <Copy className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrettyFormat}
                  disabled={isProcessing || !isValidJson}
                  title="Format JSON"
                >
                  Format
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReset}
                  disabled={isProcessing || !hasUnsavedChanges}
                  title="Reset to original"
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {/* Content Editor */}
            <div className="flex-1 min-h-0 flex flex-col">
              {isPreviewMode ? (
                <div className="flex-1 border rounded-md p-3 bg-muted/50 overflow-auto">
                  <pre className="text-sm whitespace-pre-wrap">
                    {isValidJson
                      ? JSON.stringify(JSON.parse(editedContent), null, 2)
                      : editedContent}
                  </pre>
                </div>
              ) : (
                <Textarea
                  ref={textareaRef}
                  id="memory-content"
                  value={editedContent}
                  onChange={(e) => setEditedContent(e.target.value)}
                  className={`flex-1 resize-none font-mono text-sm min-h-[300px] ${
                    !isValidJson ? 'border-red-300 focus:border-red-500' : ''
                  }`}
                  placeholder="Memory content in JSON format..."
                  disabled={isProcessing}
                  aria-describedby="json-help"
                />
              )}

              <p id="json-help" className="text-xs text-muted-foreground mt-2 flex-shrink-0">
                Edit the JSON directly. Use Ctrl+A to select all, Ctrl+Z to undo.
              </p>
            </div>
          </CardContent>

          <CardFooter className="flex justify-between flex-shrink-0">
            <Button variant="destructive" onClick={handleDelete} disabled={isProcessing}>
              <Trash className="mr-2 h-4 w-4" />
              Delete Memory
            </Button>

            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose} disabled={isProcessing}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={isProcessing || !isValidJson || !hasUnsavedChanges}
              >
                <Save className="mr-2 h-4 w-4" />
                {isUpdating ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
      <ConfirmationDialog
        open={confirmOpen}
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
