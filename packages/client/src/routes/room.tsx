import Room from '@/components/room';
import { useSearchParams } from 'react-router-dom';

export default function AgentRoute() {
  const [searchParams] = useSearchParams();
  const roomName = searchParams.get('roomname');

  // Go directly to the chat with the agent, skipping the room selection
  return <Room roomName={roomName} />;
}
