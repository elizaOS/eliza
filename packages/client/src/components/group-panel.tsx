import { Card, CardContent } from './ui/card';
import { formatAgentName } from '@/lib/utils';
import { Button } from './ui/button';
import { ImageIcon, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Input } from './ui/input';
import { Switch } from './ui/switch-button';
import { apiClient } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { type Agent, AgentStatus } from '@elizaos/core';
import { UUID } from 'crypto';
import { GROUP_CHAT_SOURCE } from '@/constants';
import { useRooms } from '@/hooks/use-query-hooks';

interface GroupPanel {
  agents: Agent[] | undefined;
  onClose: () => void;
  groupId?: UUID;
}

export default function GroupPanel({ onClose, agents, groupId }: GroupPanel) {
  const [chatName, setChatName] = useState(``);
  const [selectedAgents, setSelectedAgents] = useState<{ [key: string]: boolean }>({});
  const [creating, setCreating] = useState(false);

  const [avatar, setAvatar] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: roomsData } = useRooms();

  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (groupId) {
      const rooms = roomsData?.get(groupId);
      if (!rooms || !rooms.length) {
        return;
      }
      setChatName(rooms[0].name);
      setAvatar(rooms[0].metadata?.thumbnail);
    }
  }, [groupId]);

  const toggleAgentSelection = (agentId: string) => {
    setSelectedAgents((prev) => ({
      ...prev,
      [agentId]: !prev[agentId],
    }));
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result) {
          const img = new Image();
          img.src = e.target.result as string;
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const maxSize = 300; // Resize to max 300px width/height
            let width = img.width;
            let height = img.height;

            if (width > height) {
              if (width > maxSize) {
                height *= maxSize / width;
                width = maxSize;
              }
            } else {
              if (height > maxSize) {
                width *= maxSize / height;
                height = maxSize;
              }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, width, height);
            const resizedBase64 = canvas.toDataURL('image/jpeg', 0.8); // Reduce quality to 80%

            setAvatar(resizedBase64);
          };
        }
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <Card
        className="flex flex-col items-center gap-6 justify-between h-[70vh] w-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3 items-center justify-center w-full px-2 py-4">
          <h1 className="text-xl">Create Group Chat</h1>
        </div>

        <div
          className="w-20 h-20 rounded-full overflow-hidden flex flex-shrink-0 items-center justify-center cursor-pointer bg-cover bg-center bg-muted"
          style={{ backgroundImage: avatar ? `url(${avatar})` : undefined }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            type="file"
            accept="image/*"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />
          {!avatar && <ImageIcon className="w-6 h-6 text-white" />}
        </div>

        <CardContent className="w-full flex grow flex-col items-center overflow-y-auto">
          <div className="rounded-md w-full mb-3">
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
          <div className="flex items-center justify-center w-full grow">
            <Button
              variant={'default'}
              className={`w-[90%]`}
              onClick={async () => {
                const serverId = groupId || (crypto.randomUUID() as UUID);
                if (!chatName || !chatName.length) {
                  return;
                }
                setCreating(true);
                try {
                  const selectedAgentIds = Object.keys(selectedAgents).filter(
                    (agentId) => selectedAgents[agentId]
                  );

                  if (selectedAgentIds.length > 0) {
                    if (groupId) {
                      try {
                        await apiClient.deleteGroupChat(groupId);
                      } catch (error) {
                        console.error(error);
                      }
                    }
                    await apiClient.createGroupChat(
                      selectedAgentIds,
                      chatName,
                      serverId,
                      GROUP_CHAT_SOURCE,
                      {
                        thumbnail: avatar,
                      }
                    );
                  }
                } catch (error) {
                  console.error('Failed to create room', error);
                } finally {
                  setCreating(false);
                  navigate(`/room/${serverId}`);
                  onClose();
                  queryClient.invalidateQueries({ queryKey: ['rooms'] });
                }
              }}
              size={'default'}
              disabled={!chatName.length || Object.keys(selectedAgents).length === 0}
            >
              {creating ? <Loader2 className="animate-spin" /> : 'Create Chat'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
