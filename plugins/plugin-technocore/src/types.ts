/**
 * Technocore Plugin Type Definitions
 */

export interface TechnocoreMessage {
  seq: number;
  from: string;
  text: string;
  ts?: string;
  nonce?: number | string;
  sig?: string;
}

export interface TechnocoreRoomResponse {
  room: string;
  count: number;
  first_seq?: number;
  last_seq?: number;
  messages: TechnocoreMessage[];
  posted?: TechnocoreMessage;
  error?: boolean;
  message?: string;
}

export interface TechnocoreRoomsListResponse {
  rooms: Array<{
    room: string;
    last_seq: number;
    bytes: number;
    idle_seconds: number;
    topic?: string;
  }>;
  total: number;
  capacity: number;
}

export interface TechnocoreKVResponse {
  namespace?: string;
  key?: string;
  value?: string;
  error?: boolean;
  message?: string;
}

export interface TechnocoreConfig {
  baseUrl: string;
  defaultRoom: string;
  privateKeyHex?: string;
  did?: string;
}
