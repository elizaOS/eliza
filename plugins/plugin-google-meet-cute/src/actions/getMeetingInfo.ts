import { Action, IAgentRuntime, Memory, HandlerCallback, State, logger } from "@elizaos/core";
import { GoogleMeetAPIService } from "../services/googleMeetAPIService";
import { GetMeetingInfoParams } from "../types";

export const getMeetingInfoAction: Action = {
  name: "GET_MEETING_INFO",
  description: "Get information about a Google Meet meeting",
  similes: ["meeting info", "check meeting", "meeting status", "meeting details"],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "What's the status of the current meeting?"
        }
      },
      {
        name: "assistant", 
        content: {
          text: "I'll check the current meeting status for you.",
          action: "GET_MEETING_INFO"
        }
      }
    ],
    [
      {
        name: "user",
        content: {
          text: "Get information about meeting abc-defg-hij"
        }
      },
      {
        name: "assistant",
        content: {
          text: "I'll retrieve the information for that meeting.",
          action: "GET_MEETING_INFO"
        }
      }
    ]
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const googleMeetService = runtime.getService("google-meet-api") as GoogleMeetAPIService;
    
    if (!googleMeetService) {
      logger.error("Google Meet API service not found");
      return false;
    }
    
    return true;
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    params?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    try {
      const googleMeetService = runtime.getService("google-meet-api") as GoogleMeetAPIService;
      
      if (!googleMeetService) {
        throw new Error("Google Meet API service not found");
      }
      
      const meetingParams = params as GetMeetingInfoParams | undefined;
      
      // Try to get current meeting first
      let meeting = googleMeetService.getCurrentMeeting();
      
      // If no current meeting, try to extract meeting ID from message
      if (!meeting && message.content.text) {
        // Look for meeting codes (format: xxx-xxxx-xxx)
        const meetingCodeMatch = message.content.text.match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/i);
        if (meetingCodeMatch) {
          // For now, we'll just inform the user that we need the full meeting ID
          throw new Error("Please provide the full meeting space ID (not just the meeting code) to retrieve meeting information");
        }
        
        // Check if a specific meeting ID was provided
        if (meetingParams?.meetingId) {
          meeting = googleMeetService.getMeeting(meetingParams.meetingId);
        }
      }
      
      if (!meeting) {
        throw new Error("No active meeting found. Please create a meeting first or provide a meeting ID.");
      }
      
      const response = `📅 **Meeting Information:**
- Meeting Link: ${meeting.meetingUri}
- Meeting Code: ${meeting.meetingCode}
- Status: ${meeting.status}
- Started: ${meeting.startTime.toLocaleString()}
${meeting.endTime ? `- Ended: ${meeting.endTime.toLocaleString()}` : '- Duration: Ongoing'}
- Participants: ${meeting.participants.length}
${meeting.participants.length > 0 ? '\n**Active Participants:**\n' + meeting.participants
  .filter(p => p.isActive)
  .map(p => `  • ${p.name} (joined ${p.joinTime.toLocaleTimeString()})`)
  .join('\n') : ''}`;
      
      if (callback) {
        callback({
          text: response,
          metadata: {
            meetingId: meeting.id,
            meetingUri: meeting.meetingUri,
            meetingCode: meeting.meetingCode,
            participantCount: meeting.participants.length
          }
        });
      }
    } catch (error) {
      logger.error("Failed to get meeting info:", error);
      
      if (callback) {
        callback({
          text: `❌ Failed to get meeting info: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: true
        });
      }
    }
  }
}; 