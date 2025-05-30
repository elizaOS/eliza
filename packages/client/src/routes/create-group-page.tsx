import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAgents } from '@/hooks/use-query-hooks';
import { apiClient } from '@/lib/api';
import { getEntityId } from '@/lib/utils';
import type { Agent, UUID } from '@elizaos/core';
import { validateUuid } from '@elizaos/core';
import { PlusCircle, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function CreateGroupPage() {
  const navigate = useNavigate();
  const currentUserId = getEntityId();
  const { data: agentsResponse, isLoading: isLoadingAgents } = useAgents();
  const availableAgents = agentsResponse?.data?.agents || [];

  const [groupName, setGroupName] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<UUID[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleAgentSelection = (agentId: UUID) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) {
      setError('Group name is required.');
      return;
    }
    if (selectedAgentIds.length === 0) {
      setError('Select at least one agent to include in the group.');
      return;
    }
    setError(null);
    setIsCreating(true);

    try {
      // For now, we'll use a default/first available serverId
      // In a real app, you might let the user select or have a dedicated DM/Group server
      const servers = await apiClient.getCentralServers();
      let serverId = servers.data?.servers?.[0]?.id;

      if (!serverId) {
        // If no servers exist, create one
        const newServer = await apiClient.createCentralServer({
          name: 'Default Group Chat Server',
          sourceType: 'eliza_group_chat',
        });
        serverId = newServer.data.server.id;
      }

      if (!serverId) {
        throw new Error('Could not obtain a server ID for the group chat.');
      }

      const participantIds = [currentUserId, ...selectedAgentIds].filter(validateUuid) as UUID[];

      const result = await apiClient.createCentralGroupChat({
        name: groupName,
        participantCentralUserIds: participantIds,
        server_id: serverId,
      });

      if (result.data?.id) {
        // Navigate to the new group chat room (assuming a route like /group/:channelId)
        navigate(`/group/${result.data.id}?serverId=${serverId}`);
      } else {
        throw new Error('Failed to create group chat: No channel ID returned.');
      }
    } catch (err: any) {
      console.error('Error creating group chat:', err);
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center p-4 md:p-8">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Users className="size-8" /> Create New Group Chat
          </h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <Label htmlFor="groupName" className="text-lg">
              Group Name
            </Label>
            <Input
              id="groupName"
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Enter a name for your group"
              className="mt-2 text-base p-3"
              disabled={isCreating}
            />
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">Select Agents</h2>
            {isLoadingAgents ? (
              <p>Loading agents...</p>
            ) : availableAgents.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {availableAgents.map((agent: Partial<Agent>) => (
                  <Button
                    key={agent.id}
                    variant={selectedAgentIds.includes(agent.id as UUID) ? 'default' : 'outline'}
                    onClick={() => handleAgentSelection(agent.id as UUID)}
                    className="flex flex-col items-start p-4 h-auto text-left space-y-1.5 shadow-sm hover:shadow-md transition-shadow"
                    disabled={isCreating}
                  >
                    <span className="font-medium text-base">{agent.name}</span>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {agent.bio?.[0] || 'No bio available.'}
                    </p>
                  </Button>
                ))}
              </div>
            ) : (
              <p>No agents available to add.</p>
            )}
          </div>

          {error && <p className="text-red-500 text-sm bg-red-500/10 p-3 rounded-md">{error}</p>}

          <Button
            type="submit"
            className="w-full text-lg p-6 flex items-center gap-2"
            disabled={isCreating || isLoadingAgents}
          >
            {isCreating ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Creating Group...
              </>
            ) : (
              <>
                <PlusCircle className="size-5" /> Create Group
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
