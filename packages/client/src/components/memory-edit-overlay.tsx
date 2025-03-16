import { useUpdateMemory, useDeleteMemory } from "@/hooks/use-query-hooks";
import type { Memory, UUID } from "@elizaos/core";
import { useState } from "react";
import { Button } from "./ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./ui/card";
import { Textarea } from "./ui/textarea";
import { Trash, X, Save, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";

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
  if (!isOpen) return null;

  const { toast } = useToast();
  const { mutate: updateMemory, isPending: isUpdating } = useUpdateMemory();
  const { mutate: deleteMemory, isPending: isDeleting } = useDeleteMemory();
  
  // Initialize with the entire content object as a formatted JSON string
  const [editedContent, setEditedContent] = useState(JSON.stringify(memory.content, null, 2));
  const isProcessing = isUpdating || isDeleting;
  
  const handleSave = () => {
    if (!editedContent.trim()) {
      toast({
        title: "Error",
        description: "Memory content cannot be empty",
        variant: "destructive",
      });
      return;
    }
    
    // Validate JSON format
    try {
      const parsedContent = JSON.parse(editedContent);
      
      // Update the entire content object
      updateMemory(
        {
          agentId,
          memoryId: memory.id!,
          memoryData: {
            content: parsedContent
          }
        },
        {
          onSuccess: () => {
            onClose();
            toast({
              title: "Memory Updated",
              description: "The memory content has been successfully updated",
            });
          }
        }
      );
    } catch (error) {
      toast({
        title: "Invalid JSON",
        description: "Please enter valid JSON format",
        variant: "destructive",
      });
    }
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this memory? This action cannot be undone.")) {
      deleteMemory(
        { 
          agentId, 
          memoryId: memory.id! 
        },
        {
          onSuccess: () => {
            onClose();
            toast({
              title: "Memory Deleted",
              description: "The memory has been successfully removed",
            });
          }
        }
      );
    }
  };
  
  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };
  
  const handlePrettyFormat = () => {
    try {
      const parsed = JSON.parse(editedContent);
      setEditedContent(JSON.stringify(parsed, null, 2));
    } catch (error) {
      toast({
        title: "Format Error",
        description: "Cannot format invalid JSON",
        variant: "destructive",
      });
    }
  };
  
  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <Card
        className="w-[80%] max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-xl font-semibold">Edit Memory Content</CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        
        <Separator />
        
        <CardContent className="pt-4">
          <div className="mb-4 flex items-center bg-amber-100 dark:bg-amber-950 border border-amber-300 dark:border-amber-800 rounded-md p-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mr-2" />
            <p className="text-sm text-amber-800 dark:text-amber-200">
              You are editing raw memory content. Changes may affect agent behavior.
            </p>
          </div>
          
          <div className="mb-4 flex flex-col space-y-1">
            <span className="text-sm text-muted-foreground">ID: {memory.id}</span>
            <span className="text-sm text-muted-foreground">Created: {formatTimestamp(memory.createdAt || 0)}</span>
            <span className="text-sm text-muted-foreground">Room: {memory.roomId}</span>
            <span className="text-sm text-muted-foreground">
              Type: {memory.entityId === agentId ? "Agent Message" : "User Message"}
            </span>
          </div>
          
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="memory-content" className="text-sm font-medium flex items-center">
                Memory Content (JSON format)
              </label>
              <Button
                variant="outline" 
                size="sm" 
                onClick={handlePrettyFormat}
                disabled={isProcessing}
              >
                Format JSON
              </Button>
            </div>
            <Textarea
              id="memory-content"
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              rows={15}
              className="resize-none font-mono text-sm"
              placeholder="Memory content in JSON format..."
              disabled={isProcessing}
            />
            <p className="text-xs text-muted-foreground">
              Edit the JSON directly. Make sure to maintain valid JSON format.
            </p>
          </div>
        </CardContent>
        
        <CardFooter className="flex justify-between">
          <Button 
            variant="destructive" 
            onClick={handleDelete}
            disabled={isProcessing}
          >
            <Trash className="mr-2 h-4 w-4" />
            Delete Memory
          </Button>
          
          <Button 
            onClick={handleSave}
            disabled={isProcessing || editedContent === JSON.stringify(memory.content, null, 2)}
          >
            <Save className="mr-2 h-4 w-4" />
            Save Changes
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
} 