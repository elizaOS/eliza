/** Defines deterministic seed, fault, observation, and readback contracts for the Matrix Client-Server API simulator. */

export interface MatrixMockEventSeed {
  eventId: string;
  sender: string;
  type?: string;
  content: Record<string, unknown>;
  originServerTs: number;
}

export interface MatrixMockRoomSeed {
  roomId: string;
  name?: string;
  topic?: string;
  canonicalAlias?: string;
  joined?: boolean;
  members: Array<{
    userId: string;
    displayName?: string;
    membership?: "join" | "invite";
  }>;
  timeline?: MatrixMockEventSeed[];
}

export interface MatrixClientServerSeed {
  userId: string;
  accessToken: string;
  deviceId?: string;
  rooms: MatrixMockRoomSeed[];
}

export interface MatrixMockFault {
  status?: number;
  body?: unknown;
  rawBody?: string;
  retryAfterMs?: number;
  delayMs?: number;
}

export interface MatrixRequestObservation {
  sequence: number;
  method: string;
  path: string;
  query: Record<string, string>;
  authenticated: boolean;
  body: unknown;
}

export interface MatrixMockSnapshot {
  generation: number;
  nextBatch: string;
  requests: MatrixRequestObservation[];
  rooms: Array<{
    roomId: string;
    joined: boolean;
    timeline: MatrixMockEventSeed[];
  }>;
}
