import ChatComponent from '@/components/chat';
import { ChannelType, validateUuid, type UUID } from '@elizaos/core';
import { useParams, useSearchParams } from 'react-router-dom';
function GroupRouteContent() {
  const { channelId: channelIdFromPath } = useParams<{ channelId: string }>();
  const [searchParams] = useSearchParams();
  const messageServerIdFromQuery = searchParams.get('messageServerId');

  const channelId = validateUuid(channelIdFromPath);
  const messageServerId = validateUuid(messageServerIdFromQuery || '');

  if (!channelId || !messageServerId) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <p>Missing channel or server information.</p>
      </div>
    );
  }

  return (
    <ChatComponent
      key={channelId}
      chatType={ChannelType.GROUP}
      contextId={channelId as UUID}
      messageServerId={messageServerId as UUID}
    />
  );
}

export default function GroupRoute() {
  return <GroupRouteContent />;
}
