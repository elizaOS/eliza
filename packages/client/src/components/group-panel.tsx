import { Card, CardContent } from './ui/card';
import { formatAgentName } from '@/lib/utils';
import { Button } from './ui/button';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Input } from './ui/input';
import { Switch } from './ui/switch-button';
import { apiClient } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { type Agent, AgentStatus } from '@elizaos/core';
import { UUID } from 'crypto';

interface GroupPanel {
  agents: Agent[] | undefined;
  onClose: () => void;
}

export default function GroupPanel({ onClose, agents }: GroupPanel) {
  const [chatName, setChatName] = useState(``);
  const [selectedAgents, setSelectedAgents] = useState<{ [key: string]: boolean }>({});
  const [creating, setCreating] = useState(false);

  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const toggleAgentSelection = (agentId: string) => {
    setSelectedAgents((prev) => ({
      ...prev,
      [agentId]: !prev[agentId],
    }));
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <Card
        className="flex flex-col items-center justify-between h-[70vh] w-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3 items-center justify-center w-full px-2 py-4">
          <h1 className="text-xl">Create Group Chat</h1>
        </div>

        <div className="w-full h-full relative">
          <CardContent className="w-full h-[80%] flex flex-col items-center">
            <div className="rounded-md h-full w-full mb-3">
              <div className="flex h-full">
                <div className="p-6 flex flex-col gap-4 w-full">
                  <div className="flex flex-col gap-2 w-full">
                    <div className="font-light">Chat Name</div>
                    <Input
                      value={chatName}
                      onChange={(e) => setChatName(e.target.value)}
                      className="w-full"
                      placeholder="Enter room name"
                    />
                  </div>
                  <div className="font-light">Invite Agents</div>
                  <div className="overflow-scroll">
                    <div className="flex flex-col gap-4 pt-3">
                      {agents
                        ?.filter((agent) => agent.status === AgentStatus.ACTIVE)
                        .map((agent) => {
                          return (
                            <div key={agent.id} className="bg-muted rounded-sm h-16">
                              <div className="flex w-full h-full justify-between items-center">
                                <div className="flex gap-2 items-center h-full w-full p-4">
                                  <div className="bg-card rounded-full w-12 h-12 flex justify-center items-center overflow-hidden">
                                    {agent && agent.settings?.avatar ? (
                                      <img
                                        src={agent.settings.avatar}
                                        alt="Agent Avatar"
                                        className="w-full h-full object-contain"
                                      />
                                    ) : (
                                      formatAgentName(agent.name)
                                    )}
                                  </div>
                                  <div className="flex flex-col justify-center items-center ml-2">
                                    <div className="text-lg">{agent.name}</div>
                                  </div>
                                </div>
                                <div className="mr-6">
                                  <Switch
                                    checked={selectedAgents[agent.id as UUID]}
                                    onChange={() => toggleAgentSelection(agent.id as UUID)}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-center w-full">
              <Button
                variant={'default'}
                className={`w-[90%]`}
                onClick={async () => {
                  if (!chatName || !chatName.length) {
                    return;
                  }
                  setCreating(true);
                  try {
                    const selectedAgentIds = Object.keys(selectedAgents).filter(
                      (agentId) => selectedAgents[agentId]
                    );

                    if (selectedAgentIds.length > 0) {
                      await Promise.all(
                        selectedAgentIds.map(async (agentId) => {
                          await apiClient.createRoom(agentId, chatName, 'client_group_chat');
                        })
                      );
                    }
                    // queryClient.invalidateQueries({ queryKey: ["rooms"] });
                  } catch (error) {
                    console.error('Failed to create room', error);
                  } finally {
                    setCreating(false);
                    navigate(`/room/?roomname=${chatName}`);
                  }
                }}
                size={'default'}
                disabled={!chatName.length || Object.keys(selectedAgents).length === 0}
              >
                {creating ? <Loader2 className="animate-spin" /> : 'Create Chat'}
              </Button>
            </div>
          </CardContent>
        </div>
      </Card>
    </div>
  );
}
