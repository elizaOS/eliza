/** Core scheduling service for multi-party coordination, availability intersection, and calendar management */

import { type IAgentRuntime, logger, Service, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import {
  getAvailabilityStorage,
  getMeetingStorage,
  getReminderStorage,
  getSchedulingRequestStorage,
} from "../storage.js";
import type {
  Availability,
  CalendarEvent,
  CalendarInvite,
  DayOfWeek,
  Meeting,
  MeetingParticipant,
  MeetingStatus,
  Participant,
  ProposedSlot,
  Reminder,
  ReminderType,
  SchedulingConstraints,
  SchedulingRequest,
  SchedulingResult,
  SchedulingServiceConfig,
  TimeSlot,
} from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import { generateIcs } from "../utils/ical.js";

const DAY_INDEX: Record<string, DayOfWeek> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

const getZonedParts = (date: Date, timeZone: string): Record<string, string> => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      out[part.type] = part.value;
    }
  }
  return out;
};

const getDayOfWeek = (date: Date, timeZone: string): DayOfWeek => {
  const parts = getZonedParts(date, timeZone);
  return DAY_INDEX[parts.weekday] ?? "mon";
};

const getMinutesOfDay = (date: Date, timeZone: string): number => {
  const parts = getZonedParts(date, timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
};

const getDateString = (date: Date, timeZone: string): string => {
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const dateFromMinutes = (dateStr: string, minutes: number, timeZone: string): Date => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  // Create a date string in the target time zone
  const localDateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00`;

  // Use Intl to get the offset for this time zone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });

  // Create a temporary date to get the offset
  const tempDate = new Date(localDateStr + "Z");
  const offsetParts = formatter.formatToParts(tempDate);
  const offsetPart = offsetParts.find((p) => p.type === "timeZoneName");

  // Parse the offset (e.g., "GMT-05:00" -> -300)
  let offsetMinutes = 0;
  if (offsetPart) {
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetPart.value);
    if (match) {
      const sign = match[1] === "+" ? 1 : -1;
      offsetMinutes = sign * (Number(match[2]) * 60 + Number(match[3]));
    }
  }

  // Create the final date by adjusting for the offset
  const utcMs = Date.UTC(year, month - 1, day, hours, mins, 0, 0) - offsetMinutes * 60 * 1000;
  return new Date(utcMs);
};

const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

export class SchedulingService extends Service {
  static serviceType = "SCHEDULING";
  capabilityDescription =
    "Coordinates scheduling and calendar management across multiple participants";

  private schedulingConfig: SchedulingServiceConfig;

  constructor(runtime?: IAgentRuntime, schedulingConfig?: Partial<SchedulingServiceConfig>) {
    super(runtime);
    this.schedulingConfig = { ...DEFAULT_CONFIG, ...schedulingConfig };
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new SchedulingService(runtime);
    const healthStatus = await service.healthCheck();

    if (!healthStatus.healthy) {
      logger.warn(`[SchedulingService] Started with warnings: ${healthStatus.issues.join(", ")}`);
    } else {
      logger.info(`[SchedulingService] Started for agent ${runtime.agentId}`);
    }

    return service;
  }

  async stop(): Promise<void> {
    logger.info("[SchedulingService] Stopped");
  }

  async healthCheck(): Promise<{ healthy: boolean; issues: string[] }> {
    const issues: string[] = [];

    if (!this.runtime.getComponent) {
      issues.push("Runtime missing getComponent method");
    }
    if (!this.runtime.createComponent) {
      issues.push("Runtime missing createComponent method");
    }

    const emailService = this.runtime.getService("EMAIL");
    if (!emailService) {
      issues.push("EMAIL service not available");
    }

    return { healthy: issues.length === 0, issues };
  }

  getSchedulingConfig(): SchedulingServiceConfig {
    return { ...this.schedulingConfig };
  }

  async saveAvailability(entityId: UUID, availability: Availability): Promise<void> {
    const storage = getAvailabilityStorage(this.runtime);
    await storage.save(entityId, availability);
  }

  async getAvailability(entityId: UUID): Promise<Availability | null> {
    return getAvailabilityStorage(this.runtime).get(entityId);
  }

  isAvailableAt(availability: Availability, dateTime: Date): boolean {
    const day = getDayOfWeek(dateTime, availability.timeZone);
    const minutes = getMinutesOfDay(dateTime, availability.timeZone);
    const dateStr = getDateString(dateTime, availability.timeZone);

    // Check exceptions first
    const exception = availability.exceptions.find((e) => e.date === dateStr);
    if (exception) {
      if (exception.unavailable) return false;
      if (exception.startMinutes !== undefined && exception.endMinutes !== undefined) {
        return minutes >= exception.startMinutes && minutes < exception.endMinutes;
      }
    }

    // Check weekly availability
    return availability.weekly.some(
      (window) =>
        window.day === day && minutes >= window.startMinutes && minutes < window.endMinutes
    );
  }

  async createSchedulingRequest(
    roomId: UUID,
    title: string,
    participants: Participant[],
    constraints: Partial<SchedulingConstraints> = {},
    options?: {
      description?: string;
      urgency?: "flexible" | "soon" | "urgent";
    }
  ): Promise<SchedulingRequest> {
    const request: SchedulingRequest = {
      id: uuidv4(),
      roomId,
      title,
      description: options?.description,
      participants,
      constraints: {
        minDurationMinutes:
          constraints.minDurationMinutes ?? this.schedulingConfig.minMeetingDuration,
        preferredDurationMinutes:
          constraints.preferredDurationMinutes ?? this.schedulingConfig.defaultMeetingDuration,
        maxDaysOut: constraints.maxDaysOut ?? this.schedulingConfig.defaultMaxDaysOut,
        preferredTimes: constraints.preferredTimes,
        preferredDays: constraints.preferredDays,
        locationType: constraints.locationType,
        locationConstraint: constraints.locationConstraint,
      },
      urgency: options?.urgency ?? "flexible",
      createdAt: Date.now(),
      maxProposals: this.schedulingConfig.maxProposals,
    };

    const storage = getSchedulingRequestStorage(this.runtime);
    await storage.save(request);

    logger.info(`[SchedulingService] Created scheduling request ${request.id} for "${title}"`);
    return request;
  }

  async findAvailableSlots(request: SchedulingRequest): Promise<SchedulingResult> {
    const { participants, constraints } = request;

    if (participants.length === 0) {
      return {
        success: false,
        proposedSlots: [],
        failureReason: "No participants specified",
      };
    }

    // Collect availability for all participants
    const availabilities = participants.map((p) => ({
      participant: p,
      availability: p.availability,
    }));

    // Find common time zone (use first participant's as reference)
    const referenceTimeZone = availabilities[0].availability.timeZone;

    // Generate candidate slots for the next N days
    const now = new Date();
    const candidateSlots: TimeSlot[] = [];

    for (let dayOffset = 0; dayOffset < constraints.maxDaysOut; dayOffset++) {
      const date = addDays(now, dayOffset);
      const day = getDayOfWeek(date, referenceTimeZone);

      // Skip if not a preferred day
      if (constraints.preferredDays && !constraints.preferredDays.includes(day)) {
        continue;
      }

      const dateStr = getDateString(date, referenceTimeZone);

      // Find intersection of all weekly windows for this day
      const dayWindows = this.findDayIntersection(
        availabilities,
        day,
        dateStr,
        constraints.minDurationMinutes
      );

      for (const window of dayWindows) {
        // Generate slots within this window
        const slotDuration = constraints.preferredDurationMinutes;
        let startMinutes = window.start;

        while (startMinutes + slotDuration <= window.end) {
          // Check if this is today and the slot is in the past
          if (dayOffset === 0) {
            const currentMinutes = getMinutesOfDay(now, referenceTimeZone);
            if (startMinutes < currentMinutes + 30) {
              // At least 30 min buffer
              startMinutes += 30;
              continue;
            }
          }

          const startDate = dateFromMinutes(dateStr, startMinutes, referenceTimeZone);
          const endDate = dateFromMinutes(dateStr, startMinutes + slotDuration, referenceTimeZone);

          candidateSlots.push({
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            timeZone: referenceTimeZone,
          });

          startMinutes += 30; // Move in 30-min increments
        }
      }
    }

    if (candidateSlots.length === 0) {
      // Find which participants have no overlap
      const conflicting = this.findConflictingParticipants(availabilities);
      return {
        success: false,
        proposedSlots: [],
        failureReason: "No available time slots found within constraints",
        conflictingParticipants: conflicting,
      };
    }

    // Score and rank slots
    const scoredSlots = candidateSlots.map((slot) => this.scoreSlot(slot, request));
    scoredSlots.sort((a, b) => b.score - a.score);

    // Take top 3 slots
    const proposedSlots = scoredSlots.slice(0, 3);

    return {
      success: true,
      proposedSlots,
    };
  }

  private findDayIntersection(
    availabilities: Array<{ participant: Participant; availability: Availability }>,
    day: DayOfWeek,
    dateStr: string,
    minDuration: number
  ): Array<{ start: number; end: number }> {
    // Get windows for each participant on this day
    const participantWindows = availabilities.map(({ availability }) => {
      // Check for exceptions
      const exception = availability.exceptions.find((e) => e.date === dateStr);
      if (exception?.unavailable) {
        return [];
      }

      if (exception?.startMinutes !== undefined && exception?.endMinutes !== undefined) {
        return [{ start: exception.startMinutes, end: exception.endMinutes }];
      }

      // Use weekly windows
      return availability.weekly
        .filter((w) => w.day === day)
        .map((w) => ({ start: w.startMinutes, end: w.endMinutes }));
    });

    // Find intersection
    if (participantWindows.some((windows) => windows.length === 0)) {
      return [];
    }

    // Start with first participant's windows
    let intersection = participantWindows[0];

    // Intersect with each subsequent participant
    for (let i = 1; i < participantWindows.length; i++) {
      const newIntersection: Array<{ start: number; end: number }> = [];

      for (const windowA of intersection) {
        for (const windowB of participantWindows[i]) {
          const start = Math.max(windowA.start, windowB.start);
          const end = Math.min(windowA.end, windowB.end);

          if (end - start >= minDuration) {
            newIntersection.push({ start, end });
          }
        }
      }

      intersection = newIntersection;
      if (intersection.length === 0) break;
    }

    return intersection;
  }

  private findConflictingParticipants(
    availabilities: Array<{ participant: Participant; availability: Availability }>
  ): UUID[] {
    const conflicting: UUID[] = [];

    for (let i = 0; i < availabilities.length; i++) {
      let hasOverlapWithAll = true;

      for (let j = 0; j < availabilities.length; j++) {
        if (i === j) continue;

        const hasOverlap = this.hasAnyOverlap(
          availabilities[i].availability,
          availabilities[j].availability
        );

        if (!hasOverlap) {
          hasOverlapWithAll = false;
          break;
        }
      }

      if (!hasOverlapWithAll) {
        conflicting.push(availabilities[i].participant.entityId);
      }
    }

    return conflicting;
  }

  private hasAnyOverlap(a: Availability, b: Availability): boolean {
    for (const windowA of a.weekly) {
      for (const windowB of b.weekly) {
        if (windowA.day !== windowB.day) continue;

        const overlapStart = Math.max(windowA.startMinutes, windowB.startMinutes);
        const overlapEnd = Math.min(windowA.endMinutes, windowB.endMinutes);

        if (overlapEnd - overlapStart >= 30) {
          return true;
        }
      }
    }
    return false;
  }

  private scoreSlot(slot: TimeSlot, request: SchedulingRequest): ProposedSlot {
    const { constraints, urgency } = request;
    let score = 100;
    const reasons: string[] = [];
    const concerns: string[] = [];

    const startDate = new Date(slot.start);
    const minutes = getMinutesOfDay(startDate, slot.timeZone);
    const day = getDayOfWeek(startDate, slot.timeZone);

    // Time of day scoring
    const timeOfDay = minutes < 12 * 60 ? "morning" : minutes < 17 * 60 ? "afternoon" : "evening";

    if (constraints.preferredTimes?.includes(timeOfDay)) {
      score += 20;
      reasons.push(`Preferred time (${timeOfDay})`);
    }

    // Day of week scoring
    if (constraints.preferredDays?.includes(day)) {
      score += 15;
      reasons.push(`Preferred day (${day})`);
    }

    // Urgency scoring - earlier is better for urgent meetings
    const daysFromNow = (startDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

    if (urgency === "urgent") {
      score -= daysFromNow * 10;
      if (daysFromNow < 2) {
        reasons.push("Soon (urgent meeting)");
      }
    } else if (urgency === "soon") {
      score -= daysFromNow * 5;
    }

    // Penalize very early or very late times
    if (minutes < 9 * 60) {
      score -= 15;
      concerns.push("Early morning");
    } else if (minutes > 18 * 60) {
      score -= 10;
      concerns.push("Evening time");
    }

    // Bonus for standard business hours
    if (minutes >= 10 * 60 && minutes <= 16 * 60) {
      score += 10;
      reasons.push("Standard business hours");
    }

    return {
      slot,
      score: Math.max(0, score),
      reasons,
      concerns,
    };
  }

  async createMeeting(
    request: SchedulingRequest,
    slot: TimeSlot,
    location: {
      type: "in_person" | "virtual" | "phone";
      name?: string;
      address?: string;
      city?: string;
      videoUrl?: string;
      phoneNumber?: string;
      notes?: string;
    }
  ): Promise<Meeting> {
    const participants: MeetingParticipant[] = request.participants.map((p, index) => ({
      entityId: p.entityId,
      name: p.name,
      email: p.email,
      phone: p.phone,
      role: index === 0 ? "organizer" : "required",
      confirmed: false,
    }));

    const meeting: Meeting = {
      id: uuidv4(),
      requestId: request.id,
      roomId: request.roomId,
      title: request.title,
      description: request.description,
      slot,
      location: {
        type: location.type,
        name: location.name,
        address: location.address,
        city: location.city,
        videoUrl: location.videoUrl,
        phoneNumber: location.phoneNumber,
        notes: location.notes,
      },
      participants,
      status: "proposed",
      rescheduleCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const storage = getMeetingStorage(this.runtime);
    await storage.save(meeting);

    logger.info(`[SchedulingService] Created meeting ${meeting.id} for "${meeting.title}"`);

    // Auto-schedule reminders if configured
    if (this.schedulingConfig.autoScheduleReminders) {
      await this.scheduleReminders(meeting);
    }

    return meeting;
  }

  async getMeeting(meetingId: string): Promise<Meeting | null> {
    return getMeetingStorage(this.runtime).get(meetingId);
  }

  async getMeetingsForRoom(roomId: UUID): Promise<Meeting[]> {
    return getMeetingStorage(this.runtime).getByRoom(roomId);
  }

  async getUpcomingMeetings(entityId: UUID): Promise<Meeting[]> {
    return getMeetingStorage(this.runtime).getUpcomingForParticipant(entityId);
  }

  async confirmParticipant(meetingId: string, entityId: UUID): Promise<Meeting> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const participant = meeting.participants.find((p) => p.entityId === entityId);
    if (!participant) {
      throw new Error(`Participant not found in meeting: ${entityId}`);
    }

    participant.confirmed = true;
    participant.confirmedAt = Date.now();
    meeting.updatedAt = Date.now();

    // Check if all required participants have confirmed
    const allConfirmed = meeting.participants
      .filter((p) => p.role !== "optional")
      .every((p) => p.confirmed);

    if (allConfirmed && meeting.status === "proposed") {
      meeting.status = "confirmed";
      logger.info(`[SchedulingService] Meeting ${meetingId} confirmed by all participants`);

      // Send calendar invites if configured
      if (this.schedulingConfig.autoSendCalendarInvites) {
        await this.sendCalendarInvites(meeting);
        meeting.status = "scheduled";
      }
    }

    const storage = getMeetingStorage(this.runtime);
    await storage.save(meeting);

    return meeting;
  }

  async declineParticipant(meetingId: string, entityId: UUID, reason?: string): Promise<Meeting> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const participant = meeting.participants.find((p) => p.entityId === entityId);
    if (!participant) {
      throw new Error(`Participant not found in meeting: ${entityId}`);
    }

    participant.confirmed = false;
    participant.declineReason = reason;
    meeting.updatedAt = Date.now();

    // If a required participant declines, mark meeting for rescheduling
    if (participant.role !== "optional") {
      meeting.status = "rescheduling";
      meeting.cancellationReason = `${participant.name} declined: ${reason || "No reason given"}`;
      logger.info(`[SchedulingService] Meeting ${meetingId} needs rescheduling`);
    }

    const storage = getMeetingStorage(this.runtime);
    await storage.save(meeting);

    return meeting;
  }

  async cancelMeeting(meetingId: string, reason?: string): Promise<Meeting> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    meeting.status = "cancelled";
    meeting.cancellationReason = reason;
    meeting.updatedAt = Date.now();

    // Cancel pending reminders
    await this.cancelReminders(meetingId);

    const storage = getMeetingStorage(this.runtime);
    await storage.save(meeting);

    logger.info(`[SchedulingService] Meeting ${meetingId} cancelled`);

    return meeting;
  }

  async updateMeetingStatus(meetingId: string, status: MeetingStatus): Promise<Meeting> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    meeting.status = status;
    meeting.updatedAt = Date.now();

    const storage = getMeetingStorage(this.runtime);
    await storage.save(meeting);

    return meeting;
  }

  async rescheduleMeeting(meetingId: string, newSlot: TimeSlot, reason?: string): Promise<Meeting> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    // Cancel old reminders
    await this.cancelReminders(meetingId);

    meeting.slot = newSlot;
    meeting.status = "proposed";
    meeting.rescheduleCount += 1;
    meeting.cancellationReason = reason;
    meeting.updatedAt = Date.now();

    // Reset confirmations
    for (const participant of meeting.participants) {
      participant.confirmed = false;
      participant.confirmedAt = undefined;
    }

    const storage = getMeetingStorage(this.runtime);
    await storage.save(meeting);

    // Schedule new reminders
    if (this.schedulingConfig.autoScheduleReminders) {
      await this.scheduleReminders(meeting);
    }

    logger.info(
      `[SchedulingService] Meeting ${meetingId} rescheduled (count: ${meeting.rescheduleCount})`
    );

    return meeting;
  }

  generateCalendarInvite(
    meeting: Meeting,
    recipientEmail: string,
    recipientName: string
  ): CalendarInvite {
    const organizer = meeting.participants.find((p) => p.role === "organizer");

    const event: CalendarEvent = {
      uid: meeting.id,
      title: meeting.title,
      description: meeting.description,
      start: meeting.slot.start,
      end: meeting.slot.end,
      timeZone: meeting.slot.timeZone,
      location:
        meeting.location.type === "in_person"
          ? `${meeting.location.name}, ${meeting.location.address}`
          : meeting.location.videoUrl,
      organizer: organizer?.email ? { name: organizer.name, email: organizer.email } : undefined,
      attendees: meeting.participants
        .filter((p) => p.email)
        .map((p) => ({
          name: p.name,
          email: p.email!,
          role: p.role,
        })),
      url: meeting.location.videoUrl,
      reminderMinutes: this.schedulingConfig.defaultReminderMinutes,
    };

    const ics = generateIcs(event);

    return {
      ics,
      event,
      recipientEmail,
      recipientName,
    };
  }

  /** Sends invites via EMAIL service if available, otherwise returns ICS for manual handling */
  async sendCalendarInvites(meeting: Meeting): Promise<CalendarInvite[]> {
    const invites: CalendarInvite[] = [];

    for (const participant of meeting.participants) {
      if (!participant.email) {
        logger.warn(
          `[SchedulingService] Participant ${participant.name} has no email - skipping calendar invite`
        );
        continue;
      }

      const invite = this.generateCalendarInvite(meeting, participant.email, participant.name);
      invites.push(invite);

      const emailService = this.runtime.getService("EMAIL");
      const emailServiceAny = emailService as unknown as {
        sendEmail?: (
          to: string,
          subject: string,
          body: string,
          attachments?: Array<{ filename: string; content: string; contentType: string }>
        ) => Promise<void>;
      };
      if (emailService && typeof emailServiceAny.sendEmail === "function") {
        try {
          await emailServiceAny.sendEmail(
            participant.email,
            `Meeting Invite: ${meeting.title}`,
            this.formatInviteEmail(meeting, participant.name),
            [
              {
                filename: "invite.ics",
                content: invite.ics,
                contentType: "text/calendar",
              },
            ]
          );
          logger.info(
            `[SchedulingService] Sent calendar invite to ${participant.email} for meeting ${meeting.id}`
          );
        } catch (err) {
          logger.error(
            `[SchedulingService] Failed to send email to ${participant.email} for meeting ${meeting.id}: ${err}`
          );
        }
      } else {
        // No email service - log the limitation
        logger.warn(
          `[SchedulingService] No EMAIL service available - calendar invite for ${participant.email} generated but not sent. ` +
            `ICS content available in returned invite object.`
        );
      }
    }

    return invites;
  }

  private formatInviteEmail(meeting: Meeting, recipientName: string): string {
    const startDate = new Date(meeting.slot.start);
    const endDate = new Date(meeting.slot.end);

    const dateFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: meeting.slot.timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const timeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: meeting.slot.timeZone,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });

    let locationText = "";
    if (meeting.location.type === "virtual" && meeting.location.videoUrl) {
      locationText = `Join online: ${meeting.location.videoUrl}`;
    } else if (meeting.location.type === "in_person") {
      locationText = `Location: ${meeting.location.name}, ${meeting.location.address}`;
    } else if (meeting.location.type === "phone" && meeting.location.phoneNumber) {
      locationText = `Call: ${meeting.location.phoneNumber}`;
    }

    return `Hi ${recipientName},

You're invited to: ${meeting.title}

When: ${dateFormatter.format(startDate)}
Time: ${timeFormatter.format(startDate)} - ${timeFormatter.format(endDate)}
${locationText}

${meeting.description || ""}

Please add the attached calendar invite to your calendar.

See you there!`;
  }

  async scheduleReminders(meeting: Meeting): Promise<Reminder[]> {
    const reminders: Reminder[] = [];
    const meetingTime = new Date(meeting.slot.start).getTime();

    for (const minutesBefore of this.schedulingConfig.defaultReminderMinutes) {
      const scheduledFor = new Date(meetingTime - minutesBefore * 60 * 1000);

      // Don't schedule reminders in the past
      if (scheduledFor.getTime() < Date.now()) continue;

      for (const participant of meeting.participants) {
        // Determine reminder type based on participant info
        const type: ReminderType = participant.phone ? "sms" : participant.email ? "email" : "push";

        const timeLabel =
          minutesBefore >= 1440
            ? `${Math.round(minutesBefore / 1440)} day(s)`
            : minutesBefore >= 60
              ? `${Math.round(minutesBefore / 60)} hour(s)`
              : `${minutesBefore} minutes`;

        const reminder: Reminder = {
          id: uuidv4(),
          meetingId: meeting.id,
          participantId: participant.entityId,
          scheduledFor: scheduledFor.toISOString(),
          type,
          message: `Reminder: "${meeting.title}" is in ${timeLabel}`,
          status: "pending",
          createdAt: Date.now(),
        };

        reminders.push(reminder);
      }
    }

    const storage = getReminderStorage(this.runtime);
    for (const reminder of reminders) {
      await storage.save(reminder);
    }

    logger.debug(
      `[SchedulingService] Scheduled ${reminders.length} reminders for meeting ${meeting.id}`
    );

    return reminders;
  }

  async getDueReminders(): Promise<Reminder[]> {
    return getReminderStorage(this.runtime).getDue();
  }

  async markReminderSent(reminderId: string): Promise<void> {
    const storage = getReminderStorage(this.runtime);
    const reminder = await storage.get(reminderId);
    if (!reminder) return;

    reminder.status = "sent";
    reminder.sentAt = Date.now();
    await storage.save(reminder);
  }

  async cancelReminders(meetingId: string): Promise<void> {
    const storage = getReminderStorage(this.runtime);
    const reminders = await storage.getByMeeting(meetingId);

    for (const reminder of reminders) {
      if (reminder.status === "pending") {
        reminder.status = "cancelled";
        await storage.save(reminder);
      }
    }
  }

  formatSlot(slot: TimeSlot, locale: string = "en-US"): string {
    const start = new Date(slot.start);
    const end = new Date(slot.end);

    const dateFormatter = new Intl.DateTimeFormat(locale, {
      timeZone: slot.timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    });

    const timeFormatter = new Intl.DateTimeFormat(locale, {
      timeZone: slot.timeZone,
      hour: "numeric",
      minute: "2-digit",
    });

    return `${dateFormatter.format(start)}, ${timeFormatter.format(start)} - ${timeFormatter.format(end)}`;
  }

  getConfig(): SchedulingServiceConfig {
    return { ...this.schedulingConfig };
  }
}
