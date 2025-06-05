import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
// import { CreateGroupDialog } from '@/components/create-group-dialog'; // To be removed
import GroupPanel from '@/components/group-panel'; // Import GroupPanel
// import { useAgentsWithDetails, useServers } from '@/hooks/use-query-hooks'; // No longer needed if GroupPanel fetches its own agents
import type { UUID } from '@elizaos/core';

export default function GroupNew() {
  const navigate = useNavigate();
  // const [open, setOpen] = useState(true); // GroupPanel typically manages its own visibility or is used as a page component
  // const { data: serversData } = useServers();
  // const { data: agentsData, isLoading: isLoadingAgents } = useAgentsWithDetails(); // GroupPanel fetches its own agents
  // const [selectedServerId, setSelectedServerId] = useState<UUID | null>(null); // GroupPanel will use DEFAULT_SERVER_ID

  // useEffect(() => {
  //   // Use the first available server or create one if needed
  //   if (serversData?.data?.servers && serversData.data.servers.length > 0) {
  //     setSelectedServerId(serversData.data.servers[0].id);
  //   }
  // }, [serversData]);

  // const handleOpenChange = (open: boolean) => {
  //   setOpen(open);
  //   if (!open) {
  //     // Navigate back to home when dialog is closed
  //     navigate('/');
  //   }
  // };

  // if (!selectedServerId) { // GroupPanel handles server ID internally or gets it via props if needed for specific server contexts
  //   return (
  //     <div className="flex items-center justify-center h-screen">
  //       <p>Loading servers...</p>
  //     </div>
  //   );
  // }

  return (
    // <CreateGroupDialog open={open} onOpenChange={handleOpenChange} serverId={selectedServerId} />
    // Render GroupPanel directly as the route's content
    // GroupPanel will handle its own logic for fetching serverId (default) or if it were to be passed.
    <div className="pt-4 md:pt-8">
      <GroupPanel
        // agents={agents} // Removed prop
        onClose={() => navigate(-1)} // Navigate back on close
        // channelId is undefined, so it's in "create" mode
      />
    </div>
  );
}
