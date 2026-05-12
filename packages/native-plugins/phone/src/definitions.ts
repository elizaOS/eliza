export interface PlaceCallOptions {
  number: string;
}

export interface PhoneStatus {
  hasTelecom: boolean;
  canPlaceCalls: boolean;
  isDefaultDialer: boolean;
  defaultDialerPackage: string | null;
}

export type CallLogType =
  | "incoming"
  | "outgoing"
  | "missed"
  | "voicemail"
  | "rejected"
  | "blocked"
  | "answered_externally"
  | "unknown";

export interface CallLogEntry {
  id: string;
  number: string;
  cachedName: string | null;
  date: number;
  durationSeconds: number;
  type: CallLogType;
  rawType: number;
  isNew: boolean;
  phoneAccountId: string | null;
  geocodedLocation: string | null;
  transcription: string | null;
  voicemailUri: string | null;
  agentTranscript: string | null;
  agentSummary: string | null;
  agentTranscriptUpdatedAt: number | null;
}

export interface ListRecentCallsOptions {
  limit?: number;
  number?: string;
}

export interface SaveCallTranscriptOptions {
  callId: string;
  transcript: string;
  summary?: string;
}

export interface PhonePlugin {
  getStatus(): Promise<PhoneStatus>;
  placeCall(options: PlaceCallOptions): Promise<void>;
  openDialer(options?: Partial<PlaceCallOptions>): Promise<void>;
  listRecentCalls(options?: ListRecentCallsOptions): Promise<{
    calls: CallLogEntry[];
  }>;
  saveCallTranscript(options: SaveCallTranscriptOptions): Promise<{
    updatedAt: number;
  }>;
}
