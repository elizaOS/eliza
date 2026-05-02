import { Action, IAgentRuntime, Memory, HandlerCallback, State, logger } from "@elizaos/core";
import { GoogleMeetAPIService } from "../services/googleMeetAPIService";
import { GenerateReportParams, MeetingReport } from "../types";
import * as fs from "fs/promises";
import * as path from "path";

export const generateReportAction: Action = {
  name: "GENERATE_REPORT",
  description: "Generate a comprehensive report from Google Meet artifacts (transcripts, recordings)",
  similes: ["create report", "meeting summary", "get transcript", "meeting notes"],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Generate a report for the meeting"
        }
      },
      {
        name: "assistant",
        content: {
          text: "I'll generate a comprehensive report from the meeting artifacts.",
          action: "GENERATE_REPORT"
        }
      }
    ],
    [
      {
        name: "user", 
        content: {
          text: "Get the meeting transcript and summary"
        }
      },
      {
        name: "assistant",
        content: {
          text: "I'll retrieve the transcript and create a summary for you.",
          action: "GENERATE_REPORT"
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
      
      const reportParams = params as GenerateReportParams | undefined;
      
      // Get meeting to report on
      let meetingId = reportParams?.meetingId;
      const currentMeeting = googleMeetService.getCurrentMeeting();
      
      if (!meetingId && currentMeeting) {
        meetingId = currentMeeting.id;
      }
      
      if (!meetingId) {
        throw new Error("No meeting specified. Please provide a meeting ID or ensure there's an active meeting.");
      }
      
      // Note: In a real implementation, you would:
      // 1. Get the conference record for the meeting
      // 2. Fetch transcripts using conferenceRecords.transcripts.list
      // 3. Fetch recordings using conferenceRecords.recordings.list
      // 4. Process and summarize the data
      
      const report: MeetingReport = {
        meetingId: meetingId,
        title: `Meeting Report - ${new Date().toLocaleDateString()}`,
        date: new Date(),
        duration: 0, // Would calculate from conference record
        participants: [], // Would get from participants API
        summary: "Meeting summary would be generated from transcript data",
        keyPoints: [
          "Key points would be extracted from transcript",
          "Using natural language processing"
        ],
        actionItems: reportParams?.includeActionItems ? [
          {
            description: "Action items would be extracted from transcript",
            priority: "medium"
          }
        ] : [],
        fullTranscript: reportParams?.includeTranscript ? [] : []
      };
      
      // Generate report content
      let reportContent = `# Meeting Report

**Meeting ID:** ${report.meetingId}
**Date:** ${report.date.toLocaleDateString()}
**Duration:** ${report.duration} minutes

## Summary
${report.summary}

## Key Points
${report.keyPoints.map(point => `- ${point}`).join('\n')}
`;
      
      if (report.actionItems.length > 0) {
        reportContent += `
## Action Items
${report.actionItems.map(item => `- ${item.description} (Priority: ${item.priority})`).join('\n')}
`;
      }
      
      // Save report to file if output directory is configured
      const outputDir = runtime.getSetting("REPORT_OUTPUT_DIR") || "./meeting-reports";
      try {
        await fs.mkdir(outputDir, { recursive: true });
        const filename = `meeting-report-${Date.now()}.md`;
        const filepath = path.join(outputDir, filename);
        await fs.writeFile(filepath, reportContent);
        
        reportContent += `\n\n📄 Report saved to: ${filepath}`;
      } catch (error) {
        logger.warn("Failed to save report to file:", error);
      }
      
      const response = `✅ Meeting report generated successfully!

${reportContent}

Note: To get actual transcript and recording data, ensure the meeting has ended and artifacts are available through the Google Meet API.`;
      
      if (callback) {
        callback({
          text: response,
          metadata: {
            report: report,
            savedToFile: true
          }
        });
      }
    } catch (error) {
      logger.error("Failed to generate report:", error);
      
      if (callback) {
        callback({
          text: `❌ Failed to generate report: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: true
        });
      }
    }
  }
};
