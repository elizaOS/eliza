import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
// import { Avatar, AvatarGroup } from '@/components/ui/avatar'; // AvatarGroup removed
import type { UUID, Agent } from '@elizaos/core';
import type { MessageChannel as ClientMessageChannel } from '@/types';
import { Users, MessageCircle } from 'lucide-react';
import { generateGroupName, getEntityId } from '@/lib/utils';

// The group prop will be a central channel, enriched with server_id for navigation context
// Assume group.participants might be available or added later.
interface GroupCardProps {
  group: ClientMessageChannel & { server_id: UUID; participants?: Partial<Agent>[] };
  // onEdit?: (group: ClientMessageChannel) => void;
}

const GroupCard: React.FC<GroupCardProps> = ({ group /*, onEdit */ }) => {
  const navigate = useNavigate();
  const currentClientId = getEntityId(); // Get current client/user ID

  if (!group || !group.id) {
    return (
      <Card className="p-4 min-h-[180px] flex items-center justify-center text-muted-foreground">
        Group data not available.
      </Card>
    );
  }

  const groupName = generateGroupName(group, group.participants || [], currentClientId);
  // Assuming participant count might come from metadata or a separate query in the parent component
  const participantCount =
    group.metadata?.participantCount ||
    group.metadata?.member_count ||
    group.participants?.length ||
    0;

  const handleChatClick = () => {
    navigate(`/group/${group.id}?serverId=${group.server_id}`);
  };

  // const handleEditClick = (e: React.MouseEvent) => {
  //   e.stopPropagation();
  //   if (onEdit) onEdit(group);
  // };

  return (
    <Card className="w-full min-h-[180px] flex flex-col transition-all hover:shadow-lg">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-muted rounded-full">
            <Users className="h-6 w-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-lg truncate" title={groupName}>
            {groupName}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex-grow">
        {/* Placeholder for participant avatars or count */}
        {participantCount > 0 && (
          <p className="text-xs text-muted-foreground">{participantCount} members</p>
        )}
        {group.topic && (
          <p className="text-sm text-muted-foreground mt-1 Dtruncate">{group.topic}</p>
        )}
      </CardContent>
      <CardFooter className="p-3">
        <Button onClick={handleChatClick} className="w-full" variant="outline" size="sm">
          <MessageCircle className="mr-2 h-4 w-4" /> Open Group
        </Button>
        {/* {onEdit && (
          <Button onClick={handleEditClick} variant="ghost" size="icon" className="ml-2">
            <Settings className="h-4 w-4" />
          </Button>
        )} */}
      </CardFooter>
    </Card>
  );
};

export default GroupCard;
