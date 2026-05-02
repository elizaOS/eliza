import { Provider, IAgentRuntime, Memory, State, logger } from "@elizaos/core";
import { GoogleMeetAPIService } from "../services/googleMeetAPIService";

export const meetingProvider: Provider = {
  name: "GOOGLE_MEET_PROVIDER",
  description: "Provides current Google Meet meeting information and status",
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      const googleMeetService = runtime.getService("google-meet-api") as GoogleMeetAPIService;
      
      if (!googleMeetService) {
        return { text: "Google Meet API service not available" };
      }
      
      const currentMeeting = googleMeetService.getCurrentMeeting();
      
      if (!currentMeeting) {
        return { text: "No active Google Meet meeting" };
      }
      
      const activeParticipants = currentMeeting.participants.filter(p => p.isActive).length;
      const duration = currentMeeting.endTime ? 
        Math.round((currentMeeting.endTime.getTime() - currentMeeting.startTime.getTime()) / 1000 / 60) :
        Math.round((Date.now() - currentMeeting.startTime.getTime()) / 1000 / 60);
      
      const text = `Current Google Meet:
- Meeting Link: ${currentMeeting.meetingUri}
- Meeting Code: ${currentMeeting.meetingCode}
- Status: ${currentMeeting.status}
- Duration: ${duration} minutes
- Active Participants: ${activeParticipants}
- Total Participants: ${currentMeeting.participants.length}`;
      
      return { text };
    } catch (error) {
      logger.error("Error in meeting provider:", error);
      return { text: "Error retrieving meeting information" };
    }
  }
};
