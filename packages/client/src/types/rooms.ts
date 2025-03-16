import { ChannelType, type UUID } from '@elizaos/core';

export interface Room {
  id: string;
  name: string;
  type: ChannelType;
  entities: { id: string; agentId?: string }[];
}
