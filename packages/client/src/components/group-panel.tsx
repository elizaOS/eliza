import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { ImageIcon, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Input } from './ui/input';
import { apiClient } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { type Agent, AgentStatus } from '@elizaos/core';
import { UUID } from 'crypto';
import { GROUP_CHAT_SOURCE } from '@/constants';
import { useRooms } from '@/hooks/use-query-hooks';
import MultiSelectCombobox from './combobox';

interface GroupPanel {
  agents: Agent[] | undefined;
  onClose: () => void;
  groupId?: UUID;
}

export default function GroupPanel({ onClose, agents, groupId }: GroupPanel) {
  const [chatName, setChatName] = useState(``);
  const [selectedAgents, setSelectedAgents] = useState<Agent[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
          className="w-20 h-20 rounded-full overflow-hidden flex flex-shrink-0 items-center justify-center cursor-pointer bg-cover bg-center bg-muted hover:opacity-50"
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

        <CardContent className="w-full flex grow flex-col items-center">
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
                <MultiSelectCombobox
                  options={
                    agents
                      ?.filter((agent) => agent.status === AgentStatus.ACTIVE)
                      .map((agent) => ({
                        icon: agent.settings?.avatar || '',
                        label: agent.name,
                        id: agent.id,
                      })) || []
                  }
                  onSelect={(selected) => setSelectedAgents(selected)}
                  className="w-full"
                />
              </div>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center w-full grow gap-4">
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
                  if (selectedAgents.length > 0) {
                    if (groupId) {
                      try {
                        await apiClient.deleteGroupChat(groupId);
                      } catch (error) {
                        console.error(error);
                      }
                    }
                    await apiClient.createGroupChat(
                      selectedAgents.map((agent) => agent.id),
                      chatName,
                      serverId,
                      GROUP_CHAT_SOURCE,
                      { thumbnail: avatar }
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
              disabled={
                !chatName.length || Object.keys(selectedAgents).length === 0 || deleting || creating
              }
            >
              {creating ? (
                <Loader2 className="animate-spin" />
              ) : groupId ? (
                'Update Group'
              ) : (
                'Create Group'
              )}
            </Button>
            {groupId && (
              <Button
                variant={'secondary'}
                className={`w-[90%] text-red-500`}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await apiClient.deleteGroupChat(groupId);
                  } catch (error) {
                    console.error('Failed to delete room', error);
                  } finally {
                    setDeleting(false);
                    navigate(`/`);
                    onClose();
                    queryClient.invalidateQueries({ queryKey: ['rooms'] });
                  }
                }}
                size={'default'}
                disabled={deleting || creating}
              >
                {deleting ? <Loader2 className="animate-spin" /> : 'Delete Group'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
