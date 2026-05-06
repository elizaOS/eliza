import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import * as fs from "fs/promises";
import * as path from "path";
import { GoogleMeetAPIService } from "../services/googleMeetAPIService";
import type {
  ActionItem,
  GenerateReportParams,
  MeetingReport,
  Transcript,
} from "../types";

type ReportParams = Partial<GenerateReportParams> & {
  conferenceRecordName?: string;
  transcriptName?: string;
};

function mergedOptions(
  options?: HandlerOptions | Record<string, unknown>,
): ReportParams {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters } as ReportParams;
}

function normalizeConferenceRecord(params: ReportParams): string | null {
  const explicit = params.conferenceRecordName;
  if (
    typeof explicit === "string" &&
    explicit.startsWith("conferenceRecords/")
  ) {
    return explicit;
  }
  const meetingId = params.meetingId;
  if (
    typeof meetingId === "string" &&
    meetingId.startsWith("conferenceRecords/")
  ) {
    return meetingId;
  }
  return null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (value && typeof value === "object") {
    const record = value as { seconds?: number | string; nanos?: number };
    if (record.seconds !== undefined) {
      const seconds =
        typeof record.seconds === "string"
          ? Number(record.seconds)
          : record.seconds;
      if (!Number.isNaN(seconds)) {
        return new Date(
          seconds * 1000 + Math.floor((record.nanos ?? 0) / 1_000_000),
        );
      }
    }
  }
  return null;
}

function durationMinutes(conference: Record<string, unknown> | null): number {
  if (!conference) return 0;
  const start = toDate(conference.startTime);
  const end = toDate(conference.endTime);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}

function parseTranscript(text: string): Transcript[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [speaker, ...rest] = line.includes(":")
        ? line.split(":")
        : ["Unknown", line];
      return {
        id: `transcript-line-${index + 1}`,
        speakerName: speaker.trim() || "Unknown",
        speakerId: speaker.trim() || "unknown",
        text: rest.join(":").trim() || line,
        timestamp: new Date(0),
        confidence: 1,
      };
    });
}

function summarizeTranscript(text: string): {
  summary: string;
  keyPoints: string[];
  actionItems: ActionItem[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      summary:
        "No transcript entries were available for this conference record.",
      keyPoints: [],
      actionItems: [],
    };
  }

  const plainText = lines
    .map((line) =>
      line.includes(":") ? line.split(":").slice(1).join(":").trim() : line,
    )
    .join(" ");
  const sentences = plainText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const summary = sentences.slice(0, 3).join(" ") || plainText.slice(0, 500);
  const keyPoints = lines
    .filter((line) => line.length >= 20)
    .slice(0, 6)
    .map((line) =>
      line.includes(":") ? line.split(":").slice(1).join(":").trim() : line,
    );
  const actionItems = lines
    .filter((line) =>
      /\b(action item|todo|follow up|need to|will|should)\b/i.test(line),
    )
    .slice(0, 6)
    .map((line) => ({
      description: line.includes(":")
        ? line.split(":").slice(1).join(":").trim()
        : line,
      priority: "medium" as const,
    }));

  return { summary, keyPoints, actionItems };
}

function formatReport(report: MeetingReport, recordingUrls: string[]): string {
  const participantLines =
    report.participants.length > 0
      ? report.participants.map((participant) => `- ${participant}`).join("\n")
      : "- No participant records returned by Google Meet.";
  const keyPointLines =
    report.keyPoints.length > 0
      ? report.keyPoints.map((point) => `- ${point}`).join("\n")
      : "- No key points extracted.";
  const actionItemLines =
    report.actionItems.length > 0
      ? report.actionItems
          .map((item) => `- ${item.description} (priority: ${item.priority})`)
          .join("\n")
      : "- No action-item language detected in the transcript.";
  const recordingLines =
    recordingUrls.length > 0
      ? recordingUrls.map((url) => `- ${url}`).join("\n")
      : "- No recording export URLs returned by Google Meet.";

  return `# Meeting Report

meetingId: ${report.meetingId}
date: ${report.date.toISOString()}
durationMinutes: ${report.duration}

## Participants
${participantLines}

## Summary
${report.summary}

## Key Points
${keyPointLines}

## Action Items
${actionItemLines}

## Recordings
${recordingLines}`;
}

export const generateReportAction: Action = {
  name: "GENERATE_REPORT",
  description:
    "Generate a report from Google Meet conference records, participants, transcripts, and recordings.",
  descriptionCompressed:
    "generate Google Meet report conference record participants transcript recordings",
  similes: [
    "create report",
    "meeting summary",
    "get transcript",
    "meeting notes",
  ],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Generate a report for conferenceRecords/abc123",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll generate a report from that Google Meet conference record.",
          action: "GENERATE_REPORT",
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const googleMeetService = runtime.getService(
      "google-meet-api",
    ) as GoogleMeetAPIService;

    if (!googleMeetService) {
      logger.error("Google Meet API service not found");
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const googleMeetService = runtime.getService(
        "google-meet-api",
      ) as GoogleMeetAPIService;

      if (!googleMeetService) {
        throw new Error("Google Meet API service not found");
      }

      const params = mergedOptions(options);
      const conferenceRecordName = normalizeConferenceRecord(params);
      if (!conferenceRecordName) {
        const currentMeeting = googleMeetService.getCurrentMeeting();
        const text =
          "Google Meet reports require a conference record name such as conferenceRecords/{record}. " +
          (currentMeeting
            ? `Current meeting space ${currentMeeting.id} does not expose finished conference artifacts yet.`
            : "Create or finish a meeting first, then provide the conference record returned by Google Meet.");
        await callback?.({ text, source: message.content?.source });
        return {
          success: false,
          text,
          values: { error: "CONFERENCE_RECORD_REQUIRED" },
          data: { actionName: "GENERATE_REPORT" },
        };
      }

      const conference = (await googleMeetService.getConference(
        conferenceRecordName,
      )) as Record<string, unknown> | null;
      const participants =
        await googleMeetService.listParticipants(conferenceRecordName);
      const transcriptNames =
        typeof params.transcriptName === "string" &&
        params.transcriptName.length > 0
          ? [params.transcriptName]
          : (await googleMeetService.listTranscripts(conferenceRecordName))
              .map((transcript) => transcript?.name)
              .filter(
                (name): name is string =>
                  typeof name === "string" && name.length > 0,
              );
      const transcriptTextParts = await Promise.all(
        transcriptNames.map((transcriptName) =>
          googleMeetService.getTranscript(transcriptName),
        ),
      );
      const transcriptText = transcriptTextParts.join("\n");
      const summary = summarizeTranscript(transcriptText);
      const recordings =
        params.includeRecordings === false
          ? []
          : await googleMeetService.listRecordings(conferenceRecordName);
      const recordingUrls = (
        await Promise.all(
          recordings
            .map((recording) => recording?.name)
            .filter(
              (name): name is string =>
                typeof name === "string" && name.length > 0,
            )
            .map((recordingName) =>
              googleMeetService.getRecordingUrl(recordingName),
            ),
        )
      ).filter(
        (url): url is string => typeof url === "string" && url.length > 0,
      );

      const report: MeetingReport = {
        meetingId: conferenceRecordName,
        title: `Meeting Report - ${conferenceRecordName}`,
        date: toDate(conference?.startTime) ?? new Date(),
        duration: durationMinutes(conference),
        participants: participants.map((participant) => participant.name),
        summary: params.includeSummary === false ? "" : summary.summary,
        keyPoints: summary.keyPoints,
        actionItems:
          params.includeActionItems === false ? [] : summary.actionItems,
        fullTranscript:
          params.includeTranscript === false
            ? []
            : parseTranscript(transcriptText),
      };

      let reportContent = formatReport(report, recordingUrls);
      const outputDir =
        (runtime.getSetting("REPORT_OUTPUT_DIR") as string | undefined) ||
        "./meeting-reports";
      let savedToFile: string | null = null;
      try {
        await fs.mkdir(outputDir, { recursive: true });
        const filename = `meeting-report-${Date.now()}.md`;
        savedToFile = path.join(outputDir, filename);
        await fs.writeFile(savedToFile, reportContent);
        reportContent += `\n\nsavedToFile: ${savedToFile}`;
      } catch (error) {
        logger.warn(
          "Failed to save report to file:",
          error instanceof Error ? error.message : String(error),
        );
      }

      const response = `Meeting report generated.\n\n${reportContent}`;
      await callback?.({
        text: response,
        metadata: {
          savedToFile,
          transcriptCount: transcriptNames.length,
          recordingCount: recordingUrls.length,
          participantCount: participants.length,
          conferenceRecordName,
        },
      });
      return {
        success: true,
        text: response,
        data: {
          actionName: "GENERATE_REPORT",
          conferenceRecordName,
          savedToFile,
          transcriptCount: transcriptNames.length,
          recordingCount: recordingUrls.length,
          participantCount: participants.length,
        },
      };
    } catch (error) {
      logger.error(
        "Failed to generate report:",
        error instanceof Error ? error.message : String(error),
      );

      const text = `Failed to generate report: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      await callback?.({
        text,
        error: true,
      });
      return {
        success: false,
        text,
        values: { error: "REPORT_GENERATION_FAILED" },
        data: { actionName: "GENERATE_REPORT" },
      };
    }
  },
};
