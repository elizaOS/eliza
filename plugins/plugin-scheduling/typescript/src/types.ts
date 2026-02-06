/**
 * @module types
 * @description Type definitions for the scheduling plugin
 *
 * Key concepts:
 * - AvailabilityWindow: A recurring time slot (e.g., "Mondays 9am-5pm")
 * - SchedulingRequest: A request to find a meeting time for multiple participants
 * - Meeting: A scheduled event with time, location, and participants
 * - CalendarEvent: An ICS-compatible event for calendar invites
 */

import type { UUID } from "@elizaos/core";

// ============================================================================
// TIME AND AVAILABILITY
// ============================================================================

export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface AvailabilityWindow {
  day: DayOfWeek;
  /** Minutes from midnight in local time (0-1439) */
  startMinutes: number;
  /** Minutes from midnight in local time (0-1439) */
  endMinutes: number;
}

export interface AvailabilityException {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  /** If true, completely unavailable this day */
  unavailable?: boolean;
  /** Override start time for this day */
  startMinutes?: number;
  /** Override end time for this day */
  endMinutes?: number;
  /** Reason for the exception */
  reason?: string;
}

export interface Availability {
  /** IANA time zone (e.g., "America/New_York") */
  timeZone: string;
  /** Weekly recurring availability */
  weekly: AvailabilityWindow[];
  /** One-off exceptions */
  exceptions: AvailabilityException[];
}

export interface TimeSlot {
  /** ISO datetime string */
  start: string;
  /** ISO datetime string */
  end: string;
  /** IANA time zone */
  timeZone: string;
}

// ============================================================================
// PARTICIPANTS
// ============================================================================

export interface Participant {
  /** Entity ID in the system */
  entityId: UUID;
  /** Display name */
  name: string;
  /** Email for calendar invites (optional) */
  email?: string;
  /** Phone for SMS reminders (optional) */
  phone?: string;
  /** Their availability */
  availability: Availability;
  /** Priority weight (higher = more important to accommodate) */
  priority?: number;
}

export type ParticipantRole = "organizer" | "required" | "optional";

export interface MeetingParticipant {
  entityId: UUID;
  name: string;
  email?: string;
  phone?: string;
  role: ParticipantRole;
  /** Has this participant confirmed attendance? */
  confirmed: boolean;
  /** When they confirmed */
  confirmedAt?: number;
  /** If they declined, why */
  declineReason?: string;
}

// ============================================================================
// MEETING LOCATION
// ============================================================================

export type LocationType = "in_person" | "virtual" | "phone";

export interface MeetingLocation {
  type: LocationType;
  /** Venue name for in-person meetings */
  name?: string;
  /** Physical address */
  address?: string;
  /** City */
  city?: string;
  /** Google Places ID or similar */
  placeId?: string;
  /** Video call URL for virtual meetings */
  videoUrl?: string;
  /** Phone number for phone meetings */
  phoneNumber?: string;
  /** Additional notes */
  notes?: string;
}

// ============================================================================
// SCHEDULING REQUEST
// ============================================================================

export type SchedulingUrgency = "flexible" | "soon" | "urgent";

export interface SchedulingConstraints {
  /** Minimum meeting duration in minutes */
  minDurationMinutes: number;
  /** Preferred meeting duration in minutes */
  preferredDurationMinutes: number;
  /** Maximum days in the future to search */
  maxDaysOut: number;
  /** Preferred times of day */
  preferredTimes?: ("morning" | "afternoon" | "evening")[];
  /** Preferred days of week */
  preferredDays?: DayOfWeek[];
  /** Location type preference */
  locationType?: LocationType;
  /** Specific location constraint (e.g., "same city") */
  locationConstraint?: string;
}

export interface SchedulingRequest {
  id: string;
  /** Room/context this scheduling is happening in */
  roomId: UUID;
  /** Meeting title/purpose */
  title: string;
  /** Meeting description */
  description?: string;
  /** All participants who need to attend */
  participants: Participant[];
  /** Scheduling constraints */
  constraints: SchedulingConstraints;
  /** How urgent is this meeting */
  urgency: SchedulingUrgency;
  /** Created timestamp */
  createdAt: number;
  /** Max proposals before escalating */
  maxProposals?: number;
}

// ============================================================================
// MEETING
// ============================================================================

export type MeetingStatus =
  | "proposed" // Time proposed, awaiting confirmations
  | "confirmed" // All required participants confirmed
  | "scheduled" // Confirmed and calendar invites sent
  | "in_progress" // Meeting is happening now
  | "completed" // Meeting finished
  | "cancelled" // Meeting was cancelled
  | "rescheduling" // Being rescheduled
  | "no_show"; // One or more participants didn't show

export interface Meeting {
  id: string;
  /** Reference to the scheduling request */
  requestId: string;
  /** Room/context */
  roomId: UUID;
  /** Meeting title */
  title: string;
  /** Meeting description */
  description?: string;
  /** Scheduled time slot */
  slot: TimeSlot;
  /** Meeting location */
  location: MeetingLocation;
  /** All participants */
  participants: MeetingParticipant[];
  /** Current status */
  status: MeetingStatus;
  /** Number of times rescheduled */
  rescheduleCount: number;
  /** If cancelled/rescheduled, why */
  cancellationReason?: string;
  /** Created timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
  /** Meeting notes/agenda */
  notes?: string;
  /** Metadata */
  meta?: Record<string, unknown>;
}

// ============================================================================
// CALENDAR INTEGRATION
// ============================================================================

export interface CalendarEvent {
  /** Unique event ID */
  uid: string;
  /** Event title */
  title: string;
  /** Event description */
  description?: string;
  /** Start time (ISO string) */
  start: string;
  /** End time (ISO string) */
  end: string;
  /** IANA time zone */
  timeZone: string;
  /** Location */
  location?: string;
  /** Organizer */
  organizer?: {
    name: string;
    email: string;
  };
  /** Attendees */
  attendees?: Array<{
    name: string;
    email: string;
    role: ParticipantRole;
  }>;
  /** URL to join (for virtual meetings) */
  url?: string;
  /** Reminder minutes before event */
  reminderMinutes?: number[];
}

export interface CalendarInvite {
  /** The ICS file content */
  ics: string;
  /** Parsed event data */
  event: CalendarEvent;
  /** Recipient email */
  recipientEmail: string;
  /** Recipient name */
  recipientName: string;
}

// ============================================================================
// REMINDERS
// ============================================================================

export type ReminderType = "sms" | "email" | "whatsapp" | "push";
export type ReminderStatus = "pending" | "sent" | "failed" | "cancelled";

export interface Reminder {
  id: string;
  /** Meeting this reminder is for */
  meetingId: string;
  /** Participant to remind */
  participantId: UUID;
  /** When to send (ISO string) */
  scheduledFor: string;
  /** Reminder channel */
  type: ReminderType;
  /** Reminder message */
  message: string;
  /** Current status */
  status: ReminderStatus;
  /** When it was sent */
  sentAt?: number;
  /** Error if failed */
  error?: string;
  /** Created timestamp */
  createdAt: number;
}

// ============================================================================
// SCHEDULING RESULT
// ============================================================================

export interface ProposedSlot {
  slot: TimeSlot;
  /** Score indicating how good this slot is (higher = better) */
  score: number;
  /** Why this slot was chosen */
  reasons: string[];
  /** Any concerns about this slot */
  concerns: string[];
}

export interface SchedulingResult {
  /** Whether scheduling was successful */
  success: boolean;
  /** Proposed time slots, ranked by preference */
  proposedSlots: ProposedSlot[];
  /** If no slots found, why */
  failureReason?: string;
  /** Participants who have no availability overlap */
  conflictingParticipants?: UUID[];
}

// ============================================================================
// SERVICE TYPES
// ============================================================================

export interface SchedulingServiceConfig {
  /** Default reminder times (minutes before meeting) */
  defaultReminderMinutes: number[];
  /** Maximum proposals per scheduling request */
  maxProposals: number;
  /** How many days out to look for availability */
  defaultMaxDaysOut: number;
  /** Minimum meeting duration in minutes */
  minMeetingDuration: number;
  /** Default meeting duration in minutes */
  defaultMeetingDuration: number;
  /** Whether to auto-send calendar invites */
  autoSendCalendarInvites: boolean;
  /** Whether to auto-schedule reminders */
  autoScheduleReminders: boolean;
}

export const DEFAULT_CONFIG: SchedulingServiceConfig = {
  defaultReminderMinutes: [1440, 120], // 24 hours, 2 hours
  maxProposals: 3,
  defaultMaxDaysOut: 7,
  minMeetingDuration: 30,
  defaultMeetingDuration: 60,
  autoSendCalendarInvites: true,
  autoScheduleReminders: true,
};
