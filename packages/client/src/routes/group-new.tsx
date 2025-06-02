import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreateGroupDialog } from '@/components/create-group-dialog';
import { useServers } from '@/hooks/use-query-hooks';
import type { UUID } from '@elizaos/core';

export default function GroupNew() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const { data: serversData } = useServers();
  const [selectedServerId, setSelectedServerId] = useState<UUID | null>(null);

  useEffect(() => {
    // Use the first available server or create one if needed
    if (serversData?.data?.servers && serversData.data.servers.length > 0) {
      setSelectedServerId(serversData.data.servers[0].id);
    }
  }, [serversData]);

  const handleOpenChange = (open: boolean) => {
    setOpen(open);
    if (!open) {
      // Navigate back to home when dialog is closed
      navigate('/');
    }
  };

  if (!selectedServerId) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>Loading servers...</p>
      </div>
    );
  }

  return (
    <CreateGroupDialog open={open} onOpenChange={handleOpenChange} serverId={selectedServerId} />
  );
}
