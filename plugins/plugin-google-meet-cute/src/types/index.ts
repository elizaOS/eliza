import { z } from "zod";

// Configuration schema
export const googleMeetConfigSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default("http://localhost:3000/oauth2callback"),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_MEET_DEFAULT_DURATION_MINUTES: z.union([z.number(), z.string()]).transform(val => 
    typeof val === 'string' ? parseInt(val, 10) : val
  ).default(60),
  GOOGLE_MEET_DEFAULT_ACCESS_TYPE: z.enum(['OPEN', 'TRUSTED', 'RESTRICTED']).default('OPEN'),
});

export type GoogleMeetConfig = z.infer<typeof googleMeetConfigSchema>;

// Meeting types
export interface Meeting {
  id: string; // Space name
  meetingCode: string;
  meetingUri: string;
  title?: string;
  startTime: Date;
  endTime?: Date;
  participants: Participant[];
  transcripts: Transcript[];
  status: MeetingStatus;
}

export interface Participant {
  id: string;
  name: string;
  joinTime: Date;
  leaveTime?: Date;
  isActive: boolean;
}

export interface Transcript {
  id: string;
  speakerName: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  confidence: number;
  startTime?: number; // Start time in seconds
  endTime?: number;   // End time in seconds
}

export enum MeetingStatus {
  WAITING = "waiting",
  ACTIVE = "active", 
  ENDED = "ended",
  ERROR = "error"
}

// Report types
export interface MeetingReport {
  meetingId: string;
  title: string;
  date: Date;
  duration: number; // in minutes
  participants: string[];
  summary: string;
  keyPoints: string[];
  actionItems: ActionItem[];
  fullTranscript: Transcript[];
}

export interface ActionItem {
  description: string;
  assignee?: string;
  dueDate?: Date;
  priority: "low" | "medium" | "high";
}

// Service state
export interface GoogleMeetAPIServiceState {
  currentMeeting?: Meeting;
  isAuthenticated: boolean;
  hasRefreshToken: boolean;
}

// Action parameters
export interface CreateMeetingParams {
  accessType?: 'OPEN' | 'TRUSTED' | 'RESTRICTED';
  title?: string;
}

export interface GetMeetingInfoParams {
  meetingId?: string; // Space name or meeting code
}

export interface GenerateReportParams {
  meetingId: string;
  includeSummary?: boolean;
  includeActionItems?: boolean;
  includeTranscript?: boolean;
  includeRecordings?: boolean;
}

export interface AuthenticateParams {
  interactive?: boolean;
}
