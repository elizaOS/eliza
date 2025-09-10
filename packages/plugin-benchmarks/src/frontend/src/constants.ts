// Socket message types and constants
// These match @elizaos/core but are defined locally to avoid dependency issues

export const SOCKET_MESSAGE_TYPE = {
  ROOM_JOINING: 1,
  SEND_MESSAGE: 2,
  MESSAGE: 3,
  ACK: 4,
  THINKING: 5,
  CONTROL: 6,
} as const;

export const ChannelType = {
  SELF: 'SELF',
  DM: 'DM', 
  GROUP: 'GROUP',
  VOICE_DM: 'VOICE_DM',
  VOICE_GROUP: 'VOICE_GROUP',
  FEED: 'FEED',
  THREAD: 'THREAD',
  WORLD: 'WORLD',
  FORUM: 'FORUM',
} as const;

export const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000';
