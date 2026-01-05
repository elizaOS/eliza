import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useElizaAgents } from '@/hooks/use-eliza';
import { useServers } from '@/hooks/use-query-hooks';
import { useToast } from '@/hooks/use-toast';
import { getElizaClient } from '@/lib/api-client-config';
import type { UUID } from '@elizaos/core';
import { Loader2, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';

interface ServerManagementProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ServerManagement({ open, onOpenChange }: ServerManagementProps) {
  const { toast } = useToast();
  const { data: serversData } = useServers();
  const { agents } = useElizaAgents();

  const [selectedServerId, setSelectedServerId] = useState<UUID | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<UUID | null>(null);
  const [serverAgents, setServerAgents] = useState<Map<UUID, UUID[]>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  // Load agents for each server
  useEffect(() => {
    const loadServerAgents = async () => {
      if (!serversData?.data?.servers) return;

      const newServerAgents = new Map<UUID, UUID[]>();

      for (const server of serversData.data.servers) {
        try {
          const elizaClient = getElizaClient();
          const response = await elizaClient.agents.getAgentsForMessageServer(server.id);
          if (response.success) {
            newServerAgents.set(server.id, response.data.agents);
          }
        } catch (error) {
          console.error(`Failed to load agents for server ${server.id}:`, error);
        }
      }

      setServerAgents(newServerAgents);
    };

    loadServerAgents();
  }, [serversData]);

  const handleAddAgentToServer = async () => {
    if (!selectedServerId || !selectedAgentId) {
      toast({
        title: 'Error',
        description: 'Please select both a server and an agent',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    try {
      const elizaClient = getElizaClient();
      await elizaClient.agents.addAgentToMessageServer(selectedServerId, selectedAgentId);

      // Update local state
      setServerAgents((prev) => {
        const newMap = new Map(prev);
        const agents = newMap.get(selectedServerId) || [];
        if (!agents.includes(selectedAgentId)) {
          newMap.set(selectedServerId, [...agents, selectedAgentId]);
        }
        return newMap;
      });

      toast({
        title: 'Success',
        description: 'Agent added to server successfully',
      });

      // Reset selection
      setSelectedAgentId(null);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add agent to server',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveAgentFromServer = async (serverId: UUID, agentId: UUID) => {
    setIsLoading(true);
    try {
      const elizaClient = getElizaClient();
      await elizaClient.agents.removeAgentFromMessageServer(serverId, agentId);

      // Update local state
      setServerAgents((prev) => {
        const newMap = new Map(prev);
        const agents = newMap.get(serverId) || [];
        newMap.set(
          serverId,
          agents.filter((id) => id !== agentId)
        );
        return newMap;
      });

      toast({
        title: 'Success',
        description: 'Agent removed from server successfully',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to remove agent from server',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getAgentName = (agentId: UUID) => {
    const agent = agents?.find((a) => a.id === agentId);
    return agent?.name || agentId;
  };

  const getAvailableAgents = () => {
    if (!selectedServerId || !agents) return [];

    const currentAgents = serverAgents.get(selectedServerId) || [];
    return agents.filter((agent) => agent.id && !currentAgents.includes(agent.id as UUID));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Server Management</DialogTitle>
          <DialogDescription>
            Manage server-agent associations. Add or remove agents from servers to control which
            agents can process messages.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Server Selection */}
          <div className="space-y-2">
            <Label>Select Server</Label>
            <Select
              value={selectedServerId || undefined}
              onValueChange={(value) => setSelectedServerId(value as UUID)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a server" />
              </SelectTrigger>
              <SelectContent>
                {serversData?.data?.servers.map((server) => (
                  <SelectItem key={server.id} value={server.id}>
                    {server.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Server Agents */}
          {selectedServerId && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Agents in Server</CardTitle>
                <CardDescription>Agents currently associated with this server</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[200px]">
                  <div className="space-y-2">
                    {(serverAgents.get(selectedServerId) || []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No agents in this server</p>
                    ) : (
                      (serverAgents.get(selectedServerId) || []).map((agentId) => (
                        <div
                          key={agentId}
                          className="flex items-center justify-between p-2 rounded-lg border"
                        >
                          <span className="text-sm font-medium">{getAgentName(agentId)}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveAgentFromServer(selectedServerId, agentId)}
                            disabled={isLoading}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          )}

          {/* Add Agent Section */}
          {selectedServerId && (
            <div className="space-y-2">
              <Label>Add Agent to Server</Label>
              <div className="flex gap-2">
                <Select
                  value={selectedAgentId || undefined}
                  onValueChange={(value) => setSelectedAgentId(value as UUID)}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Choose an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {getAvailableAgents().map((agent) => (
                      <SelectItem key={agent.id} value={agent.id!}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={handleAddAgentToServer} disabled={!selectedAgentId || isLoading}>
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
