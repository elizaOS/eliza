import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api";
import { Trash2, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { UUID } from "@elizaos/core";

interface KnowledgeItem {
  id: string;
  filename: string;
  type: string;
  size: number;
  uploadedAt: number;
  preview?: string;
}

export function KnowledgeViewer({ agentId }: { agentId: UUID }) {
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const { toast } = useToast();
  
  const fetchKnowledge = async () => {
    try {
      setIsLoading(true);
      const response = await apiClient.getKnowledge(agentId);
      if (response.success) {
        setKnowledge(response.data);
      }
    } catch (error) {
      console.error("Error fetching knowledge:", error);
      toast({
        title: "Error",
        description: "Failed to fetch knowledge items",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };
  
  useEffect(() => {
    fetchKnowledge();
  }, [agentId]);
  
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    try {
      setIsUploading(true);
      const fileArray = Array.from(files);
      
      const response = await apiClient.uploadKnowledge(agentId, fileArray);
      
      if (response.success) {
        toast({
          title: "Success",
          description: `Uploaded ${fileArray.length} file(s)`,
        });
        fetchKnowledge();
      }
    } catch (error) {
      console.error("Error uploading knowledge:", error);
      toast({
        title: "Error",
        description: "Failed to upload knowledge",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      // Reset the file input
      event.target.value = "";
    }
  };
  
  const handleDelete = async (knowledgeId: string) => {
    try {
      await apiClient.deleteKnowledge(agentId, knowledgeId);
      toast({
        title: "Success",
        description: "Knowledge item deleted",
      });
      setKnowledge(knowledge.filter(item => item.id !== knowledgeId));
    } catch (error) {
      console.error("Error deleting knowledge:", error);
      toast({
        title: "Error",
        description: "Failed to delete knowledge item",
        variant: "destructive",
      });
    }
  };
  
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Number.parseFloat((bytes / (k ** i)).toFixed(2)) + " " + sizes[i];
  };
  
  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-medium">Knowledge Base</h3>
        <div>
          <input
            type="file"
            id="knowledge-upload"
            multiple
            className="hidden"
            onChange={handleFileUpload}
            accept=".md,.ts,.tsx,.txt"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => document.getElementById("knowledge-upload")?.click()}
            disabled={isUploading}
            className="gap-1.5"
          >
            <Upload className="h-4 w-4" />
            <span>{isUploading ? "Uploading..." : "Upload Files"}</span>
          </Button>
        </div>
      </div>
      
      <p className="text-sm text-muted-foreground mb-4">
        Upload .md, .ts, .tsx, or .txt files to add to the agent's knowledge base.
        Files will be processed and made available for the agent to reference.
      </p>
      
      {isLoading ? (
        <div className="flex items-center justify-center h-full">
          <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : knowledge.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <p>No knowledge items found</p>
          <p className="text-sm mt-1">Upload files to add to the agent's knowledge base</p>
        </div>
      ) : (
        <div className="space-y-2 overflow-y-auto">
          {knowledge.map((item) => (
            <div
              key={item.id}
              className="flex flex-col p-3 border rounded-md bg-card"
            >
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="font-medium truncate max-w-[250px]" title={item.filename}>
                    {item.filename}
                  </span>
                  <div className="flex gap-2 text-xs text-muted-foreground">
                    <span>{formatFileSize(item.size)}</span>
                    <span>•</span>
                    <span>{new Date(item.uploadedAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(item.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {item.preview && (
                <div className="mt-2 p-2 text-sm bg-muted rounded-md text-muted-foreground">
                  <p className="line-clamp-3 whitespace-pre-line">{item.preview}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
} 