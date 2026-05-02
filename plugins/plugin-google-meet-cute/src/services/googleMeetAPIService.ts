import { Service, IAgentRuntime, logger } from "@elizaos/core";
import { SpacesServiceClient, ConferenceRecordsServiceClient } from '@google-apps/meet';
import { GoogleAuthService } from "./googleAuthService";
import { Meeting, MeetingStatus, Participant, Transcript } from "../types";

export class GoogleMeetAPIService extends Service {
  private authService: GoogleAuthService | null = null;
  private spacesClient: SpacesServiceClient | null = null;
  private conferenceClient: ConferenceRecordsServiceClient | null = null;
  private currentMeeting: Meeting | null = null;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info("Starting Google Meet API Service");
    const service = new GoogleMeetAPIService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.authService = this.runtime.getService("google-auth") as GoogleAuthService;
    if (!this.authService) {
      throw new Error("Google Auth Service not found");
    }

    // Initialize clients with auth
    const authClient = this.authService.getOAuth2Client();
    // @google-apps/meet expects auth to be passed in options
    const auth = authClient as any;
    this.spacesClient = new SpacesServiceClient({ auth });
    this.conferenceClient = new ConferenceRecordsServiceClient({ auth });
  }

  get capabilityDescription(): string {
    return "Google Meet API integration for creating and managing meetings";
  }

  async createMeeting(params?: {
    title?: string;
    accessType?: string;
    duration?: number;
  }): Promise<Meeting> {
    if (!this.spacesClient) {
      throw new Error("Meet API client not initialized");
    }

    try {
      const request: any = {};
      
      // Set meeting configuration
      if (params?.accessType) {
        switch (params.accessType.toUpperCase()) {
          case 'TRUSTED':
            request.accessType = 'TRUSTED';
            break;
          case 'RESTRICTED':
            request.accessType = 'RESTRICTED';
            break;
          default:
            request.accessType = 'OPEN';
        }
      }

      const [space] = await this.spacesClient.createSpace({ space: request });
      
      if (!space || !space.name) {
        throw new Error("Failed to create meeting space");
      }

      // Extract meeting code from the space name
      const meetingCode = space.meetingCode || '';
      
      this.currentMeeting = {
        id: space.name,
        meetingCode: meetingCode,
        meetingUri: space.meetingUri || `https://meet.google.com/${meetingCode}`,
        title: params?.title || "Meeting",
        startTime: new Date(),
        status: MeetingStatus.WAITING,
        participants: [],
        transcripts: []
      };

      return this.currentMeeting;
    } catch (error) {
      logger.error("Failed to create meeting:", error);
      throw error;
    }
  }

  async getMeetingSpace(spaceName: string): Promise<any> {
    if (!this.spacesClient) {
      throw new Error("Meet API client not initialized");
    }

    try {
      const [space] = await this.spacesClient.getSpace({ name: spaceName });
      return space;
    } catch (error) {
      logger.error(`Failed to get meeting space ${spaceName}:`, error);
      throw error;
    }
  }

  async getConference(conferenceRecordName: string): Promise<any> {
    if (!this.conferenceClient) {
      throw new Error("Meet API client not initialized");
    }

    try {
      const [conference] = await this.conferenceClient.getConferenceRecord({
        name: conferenceRecordName
      });
      return conference;
    } catch (error) {
      logger.error(`Failed to get conference ${conferenceRecordName}:`, error);
      throw error;
    }
  }

  async listParticipants(conferenceRecordName: string): Promise<Participant[]> {
    if (!this.conferenceClient) {
      throw new Error("Meet API client not initialized");
    }

    try {
      const participants: Participant[] = [];
      
      // Use the async iterator to list participants
      const iterable = this.conferenceClient.listParticipantsAsync({
        parent: conferenceRecordName,
        pageSize: 100
      });

      for await (const participant of iterable) {
        if (participant.name) {
          // Handle different participant types based on the API structure
          let displayName = "Unknown";
          
          // Check if it's a signedinUser
          if (participant.signedinUser) {
            displayName = participant.signedinUser.displayName || participant.signedinUser.user || "Signed-in User";
          }
          // Check if it's an anonymousUser
          else if (participant.anonymousUser) {
            displayName = participant.anonymousUser.displayName || "Anonymous User";
          }
          // Check if it's a phoneUser
          else if (participant.phoneUser) {
            displayName = participant.phoneUser.displayName || "Phone User";
          }
          
          participants.push({
            id: participant.name,
            name: displayName,
            joinTime: participant.earliestStartTime ? 
              new Date((participant.earliestStartTime as any).seconds * 1000) : 
              new Date(),
            leaveTime: participant.latestEndTime ? 
              new Date((participant.latestEndTime as any).seconds * 1000) : 
              undefined,
            isActive: !participant.latestEndTime
          });
        }
      }
      
      return participants;
    } catch (error) {
      logger.error(`Failed to list participants for ${conferenceRecordName}:`, error);
      throw error;
    }
  }

  async getTranscript(transcriptName: string): Promise<string> {
    if (!this.conferenceClient) {
      throw new Error("Meet API client not initialized");
    }

    try {
      const [transcript] = await this.conferenceClient.getTranscript({
        name: transcriptName
      });
      
      if (!transcript) {
        throw new Error("Invalid transcript response");
      }

      // Get transcript entries
      let fullTranscript = "";
      const iterable = this.conferenceClient.listTranscriptEntriesAsync({
        parent: transcriptName
      });

      for await (const entry of iterable) {
        const speaker = entry.participant || "Unknown";
        const text = entry.text || "";
        fullTranscript += `${speaker}: ${text}\n`;
      }

      return fullTranscript;
    } catch (error) {
      logger.error(`Failed to get transcript ${transcriptName}:`, error);
      throw error;
    }
  }

  async listRecordings(conferenceRecordName: string): Promise<any[]> {
    if (!this.conferenceClient) {
      throw new Error("Meet API client not initialized");
    }

    try {
      const recordings: any[] = [];
      const iterable = this.conferenceClient.listRecordingsAsync({
        parent: conferenceRecordName
      });

      for await (const recording of iterable) {
        recordings.push(recording);
      }

      return recordings;
    } catch (error) {
      logger.error(`Failed to list recordings for ${conferenceRecordName}:`, error);
      throw error;
    }
  }

  async getRecordingUrl(recordingName: string): Promise<string | null> {
    if (!this.conferenceClient) {
      throw new Error("Meet API client not initialized");
    }

    try {
      const [recording] = await this.conferenceClient.getRecording({
        name: recordingName
      });
      
      return recording?.driveDestination?.exportUri || null;
    } catch (error) {
      logger.error(`Failed to get recording ${recordingName}:`, error);
      return null;
    }
  }

  async endMeeting(spaceName: string): Promise<void> {
    if (!this.spacesClient) {
      throw new Error("Meet API client not initialized");
    }

    try {
      await this.spacesClient.endActiveConference({
        name: spaceName
      });
      
      if (this.currentMeeting?.id === spaceName) {
        this.currentMeeting.status = MeetingStatus.ENDED;
        this.currentMeeting.endTime = new Date();
      }
    } catch (error) {
      logger.error(`Failed to end meeting ${spaceName}:`, error);
      throw error;
    }
  }

  getCurrentMeeting(): Meeting | null {
    return this.currentMeeting;
  }

  getMeeting(meetingId: string): Meeting | null {
    if (this.currentMeeting?.id === meetingId) {
      return this.currentMeeting;
    }
    return null;
  }

  async stop(): Promise<void> {
    this.currentMeeting = null;
    this.spacesClient = null;
    this.conferenceClient = null;
  }
} 