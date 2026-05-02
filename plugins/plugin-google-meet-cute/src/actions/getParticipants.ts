import { Action, IAgentRuntime, Memory, HandlerCallback, State, logger } from "@elizaos/core";
import { GoogleMeetAPIService } from "../services/googleMeetAPIService";

export const getParticipantsAction: Action = {
  name: "GET_PARTICIPANTS",
  description: "Get the list of participants in a Google Meet conference",
  similes: ["who's in the meeting", "list participants", "attendees", "who joined"],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Who's in the meeting?"
        }
      },
      {
        name: "assistant", 
        content: {
          text: "I'll check who's currently in the meeting.",
          action: "GET_PARTICIPANTS"
        }
      }
    ],
    [
      {
        name: "user",
        content: {
          text: "List all participants"
        }
      },
      {
        name: "assistant",
        content: {
          text: "Let me get the participant list for you.",
          action: "GET_PARTICIPANTS"
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
      
      // For now, this is a placeholder since we need conference record name
      // In a real implementation, we would need to:
      // 1. Get the current meeting space
      // 2. Find the active conference in that space
      // 3. Get the conference record name
      // 4. List participants for that conference
      
      const currentMeeting = googleMeetService.getCurrentMeeting();
      if (!currentMeeting) {
        throw new Error("No active meeting found. Please create or join a meeting first.");
      }
      
      // Note: In the actual implementation, you would need to:
      // 1. Call spaces.get with the meeting ID to get the active conference
      // 2. Use the conference record name to list participants
      
      const response = `👥 **Meeting Participants:**

${currentMeeting.participants.length === 0 ? 
  'No participants have joined yet.' : 
  currentMeeting.participants.map((p, index) => {
    const status = p.isActive ? '🟢' : '⚫';
    const duration = p.leaveTime ? 
      `(${Math.round((p.leaveTime.getTime() - p.joinTime.getTime()) / 1000 / 60)} min)` : 
      '(active)';
    return `${index + 1}. ${status} ${p.name} - Joined at ${p.joinTime.toLocaleTimeString()} ${duration}`;
  }).join('\n')}

**Total participants:** ${currentMeeting.participants.length}
**Currently active:** ${currentMeeting.participants.filter(p => p.isActive).length}`;
      
      if (callback) {
        callback({
          text: response,
          metadata: {
            totalParticipants: currentMeeting.participants.length,
            activeParticipants: currentMeeting.participants.filter(p => p.isActive).length,
            participants: currentMeeting.participants.map(p => ({
              name: p.name,
              isActive: p.isActive,
              joinTime: p.joinTime.toISOString()
            }))
          }
        });
      }
    } catch (error) {
      logger.error("Failed to get participants:", error);
      
      if (callback) {
        callback({
          text: `❌ Failed to get participants: ${error instanceof Error ? error.message : 'Unknown error'}

Note: To get real-time participant data, ensure you have an active conference record name from a running meeting.`,
          error: true
        });
      }
    }
  }
}; 