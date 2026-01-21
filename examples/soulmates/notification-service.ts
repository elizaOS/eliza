import type { IAgentRuntime, Plugin, Service, UUID } from "@elizaos/core";
import { Service as BaseService } from "@elizaos/core";
import type {
  EngineState,
  MatchRecord,
  MeetingRecord,
  Persona,
} from "./engine/types";
import {
  listUserStates,
  type MatchRevealState,
  saveUserState,
  type UserFlowState,
} from "./flow-orchestrator";
import type { MatchingService } from "./matching-service";
import {
  generateInsight,
  hashStringToSeed,
  pickDiscoveryQuestions,
} from "./soulmates-form";
import { ensureSystemContext } from "./system-context";

interface SmsService extends Service {
  sendSms: (
    to: string,
    body: string,
    mediaUrl?: string[],
    fromOverride?: string,
  ) => Promise<{
    sid: string;
  }>;
}

type ReminderEntry = {
  reminder24hSentAt?: number;
  reminder2hSentAt?: number;
  feedbackPromptSentAt?: number;
};

type ReminderState = {
  reminders: Record<string, ReminderEntry>;
};

const REMINDER_COMPONENT = "soulmates_meeting_reminders";

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Check if it's within quiet hours for a user's time zone.
 * Default quiet hours: 10pm - 8am local time
 */
const isQuietHours = (timeZone?: string): boolean => {
  const quietStart = parseNumber(process.env.SOULMATES_QUIET_START_HOUR, 22);
  const quietEnd = parseNumber(process.env.SOULMATES_QUIET_END_HOUR, 8);

  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? "UTC",
      hour: "numeric",
      hour12: false,
    });
    const hourStr = formatter.format(now);
    const hour = Number.parseInt(hourStr, 10);

    if (quietStart > quietEnd) {
      // Quiet hours span midnight (e.g., 22:00 - 08:00)
      return hour >= quietStart || hour < quietEnd;
    }
    // Quiet hours within same day
    return hour >= quietStart && hour < quietEnd;
  } catch {
    return false;
  }
};

/**
 * Add variable jitter to check-in timing (±2 hours by default)
 * This makes the bot feel less robotic
 */
const addTimingJitter = (baseMs: number, jitterHours = 2): number => {
  const jitterMs = jitterHours * 60 * 60 * 1000;
  const randomOffset = (Math.random() - 0.5) * 2 * jitterMs;
  return Math.max(0, baseMs + randomOffset);
};

const notifyAdmin = async (
  runtime: IAgentRuntime,
  message: string,
): Promise<void> => {
  const adminNumber = process.env.SOULMATES_ADMIN_ALERT_NUMBER;
  if (!adminNumber) return;
  const twilio = runtime.getService<SmsService>("twilio");
  if (!twilio) return;
  await twilio.sendSms(adminNumber, message);
};

const formatMeetingTime = (
  scheduledAt: string | number,
  timeZone?: string,
): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(scheduledAt));

const getMeetingForMatch = (
  engineState: EngineState,
  match: MatchRecord,
): MeetingRecord | undefined =>
  match.scheduledMeetingId
    ? engineState.meetings.find(
        (meeting) => meeting.meetingId === match.scheduledMeetingId,
      )
    : undefined;

const getPersonaById = (
  engineState: EngineState,
  personaId: number,
): Persona | undefined =>
  engineState.personas.find((persona) => persona.id === personaId);

export class NotificationService extends BaseService {
  static serviceType = "SOULMATES_NOTIFICATIONS";
  capabilityDescription = "Schedules check-ins, match reveals, and reminders";

  private interval: ReturnType<typeof setInterval> | null = null;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new NotificationService(runtime);
    service.startLoop();
    return service;
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private startLoop(): void {
    const tickMinutes = parseNumber(
      process.env.SOULMATES_NOTIFICATION_TICK_MINUTES,
      5,
    );
    const intervalMs = Math.max(60_000, tickMinutes * 60 * 1000);
    this.tick().catch((error) => {
      this.runtime.logger.error(
        `[Notifications] Tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.interval = setInterval(() => {
      this.tick().catch((error) => {
        this.runtime.logger.error(
          `[Notifications] Tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, intervalMs);
  }

  private async tick(): Promise<void> {
    const matchingService =
      this.runtime.getService<MatchingService>("SOULMATES_MATCHING");
    if (!matchingService) return;

    const [engineState, states, reminderState] = await Promise.all([
      matchingService.getEngineState(),
      listUserStates(),
      this.loadReminderState(),
    ]);

    await this.handleCheckIns(states);
    await this.handleProgressiveProfiling(states);
    await this.handleMatchReveals(states, engineState, matchingService);
    await this.handleMeetingEscalations(states);
    await this.handleGroupMeetings(states);
    await this.handleReliabilityCoaching(states);
    await this.handleGraduatedReactivation(states);
    const updatedReminder = await this.handleMeetingReminders(
      states,
      engineState,
      matchingService,
      reminderState,
    );
    await this.saveReminderState(updatedReminder);
  }

  private async sendSms(
    state: UserFlowState,
    text: string,
    ignoreQuietHours = false,
  ): Promise<boolean> {
    if (!state.consent.granted) return false;
    const phone = state.phoneNumber;
    if (!phone) return false;

    // Respect quiet hours unless explicitly overridden (e.g., safety alerts)
    if (!ignoreQuietHours && isQuietHours(state.profile.timeZone)) {
      return false;
    }

    const twilio = this.runtime.getService<SmsService>("twilio");
    if (!twilio) return false;
    await twilio.sendSms(phone, text);
    return true;
  }

  private async handleCheckIns(states: UserFlowState[]): Promise<void> {
    const now = Date.now();
    const intervalHours = parseNumber(
      process.env.SOULMATES_CHECKIN_INTERVAL_HOURS,
      168,
    );
    const reminderHours = parseNumber(
      process.env.SOULMATES_CHECKIN_REMINDER_HOURS,
      24,
    );
    const pauseHours = parseNumber(
      process.env.SOULMATES_CHECKIN_PAUSE_HOURS,
      720,
    );
    const jitterHours = parseNumber(
      process.env.SOULMATES_CHECKIN_JITTER_HOURS,
      2,
    );
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const reminderMs = reminderHours * 60 * 60 * 1000;
    const pauseMs = pauseHours * 60 * 60 * 1000;
    const community =
      process.env.SOULMATES_DEFAULT_COMMUNITY ?? "your community";

    for (const state of states) {
      if (
        state.stage !== "matching_queue" &&
        state.stage !== "active" &&
        state.stage !== "paused"
      ) {
        continue;
      }
      if (state.checkIn.status === "paused") {
        if (state.checkIn.nextCheckInAt && now < state.checkIn.nextCheckInAt) {
          continue;
        }
        state.checkIn.status = "idle";
        state.checkIn.nextCheckInAt = undefined;
        if (state.stage === "paused") {
          state.stage = "active";
          state.pausedAt = undefined;
        }
      }

      const lastSent = state.checkIn.lastSentAt ?? state.lastInteractionAt;
      // Apply jitter to base interval for variable timing
      const jitteredInterval = addTimingJitter(intervalMs, jitterHours);
      const dueAt = state.checkIn.nextCheckInAt ?? lastSent + jitteredInterval;

      if (state.checkIn.status === "idle" && now >= dueAt) {
        const sent = await this.sendSms(
          state,
          `Hi ${state.profile.fullName ?? "there"}, ready to meet someone new from ${community}? Reply YES, NO, or LATER.`,
        );
        if (sent) {
          state.checkIn.status = "pending";
          state.checkIn.lastSentAt = now;
          state.checkIn.lastReminderAt = undefined;
          state.checkIn.pendingDecision = undefined;
          // Pre-compute next check-in with jitter for when they respond
          state.checkIn.nextCheckInAt =
            now + addTimingJitter(intervalMs, jitterHours);
          await saveUserState(state);
        }
        continue;
      }

      if (state.checkIn.status === "pending" && state.checkIn.lastSentAt) {
        if (
          !state.checkIn.lastReminderAt &&
          now - state.checkIn.lastSentAt >= reminderMs
        ) {
          const sent = await this.sendSms(
            state,
            "Just checking in. Reply YES to meet someone new, NO to pause, or LATER to hear from me soon.",
          );
          if (sent) {
            state.checkIn.lastReminderAt = now;
            await saveUserState(state);
          }
        }

        if (now - state.checkIn.lastSentAt >= pauseMs) {
          const sent = await this.sendSms(
            state,
            "I have not heard back, so I will pause matching for now. Reply READY when you want to start again.",
          );
          if (sent) {
            state.stage = "paused";
            state.pausedAt = now;
            state.checkIn.status = "paused";
            await saveUserState(state);
          }
        }
      }
    }
  }

  private async handleProgressiveProfiling(
    states: UserFlowState[],
  ): Promise<void> {
    const now = Date.now();
    const intervalDays = parseNumber(
      process.env.SOULMATES_PROGRESSIVE_QUESTION_DAYS,
      14,
    );
    const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
    const maxQuestions = parseNumber(
      process.env.SOULMATES_PROGRESSIVE_MAX_QUESTIONS,
      6,
    );

    for (const state of states) {
      if (state.stage !== "active") continue;
      if (state.pendingDiscoveryQuestion) continue;
      const answered = state.profile.discoveryAnswers?.length ?? 0;
      if (answered >= maxQuestions) continue;
      if (state.lastInsightSentAt && now - state.lastInsightSentAt < intervalMs)
        continue;

      const domain =
        state.intent === "love"
          ? "love"
          : state.intent === "friendship"
            ? "friendship"
            : state.intent === "business"
              ? "business"
              : undefined;
      const seed = hashStringToSeed(`${state.entityId}:${now}`);
      const [question] = pickDiscoveryQuestions(1, seed, domain);
      if (!question) continue;

      const insight = generateInsight({
        fullName: state.profile.fullName ?? null,
        intent: state.intent ?? null,
        desiredFeeling: state.profile.desiredFeeling ?? null,
        coreDesire: state.profile.coreDesire ?? null,
      });

      const sent = await this.sendSms(
        state,
        `${insight}\n\nOne quick question: ${question.text}`,
      );
      if (!sent) continue;

      state.pendingDiscoveryQuestion = {
        questionId: question.id,
        theme: question.theme,
        question: question.text,
        askedAt: now,
      };
      state.lastInsightSentAt = now;
      await saveUserState(state);
    }
  }

  private async handleMatchReveals(
    states: UserFlowState[],
    engineState: EngineState,
    matchingService: MatchingService,
  ): Promise<void> {
    const now = Date.now();
    const phase2Hours = parseNumber(
      process.env.SOULMATES_MATCH_REVEAL_PHASE2_HOURS,
      6,
    );
    const phase3Hours = parseNumber(
      process.env.SOULMATES_MATCH_REVEAL_PHASE3_HOURS,
      12,
    );
    const phase4Hours = parseNumber(
      process.env.SOULMATES_MATCH_REVEAL_PHASE4_HOURS,
      18,
    );
    const delays = {
      1: phase2Hours * 60 * 60 * 1000,
      2: phase3Hours * 60 * 60 * 1000,
      3: phase4Hours * 60 * 60 * 1000,
    };

    for (const state of states) {
      if (state.matchReveals.length === 0) continue;

      const nextReveals: MatchRevealState[] = [];
      for (const reveal of state.matchReveals) {
        if (now < reveal.nextPhaseAt) {
          nextReveals.push(reveal);
          continue;
        }

        const match = engineState.matches.find(
          (m) => m.matchId === reveal.matchId,
        );
        if (!match) continue;
        const meeting = getMeetingForMatch(engineState, match);
        const personaId = await matchingService.getPersonaIdForEntity(
          state.entityId,
        );
        const persona = personaId
          ? getPersonaById(engineState, personaId)
          : undefined;
        const timeZone = persona?.profile.availability.timeZone ?? "UTC";

        if (reveal.phase === 1) {
          const timeText = meeting
            ? formatMeetingTime(meeting.scheduledAt, timeZone)
            : "soon";
          const sent = await this.sendSms(
            state,
            `Your schedules line up around ${timeText}. Want me to make the intro? Reply INTRO.`,
          );
          if (sent) {
            state.pendingIntroMatchId = match.matchId;
            nextReveals.push({
              ...reveal,
              phase: 2,
              nextPhaseAt: now + delays[1],
            });
          }
          continue;
        }

        if (reveal.phase === 2) {
          const sent = await this.sendSms(
            state,
            "I can share a warm intro and a proposed time. Reply INTRO to continue.",
          );
          if (sent) {
            nextReveals.push({
              ...reveal,
              phase: 3,
              nextPhaseAt: now + delays[2],
            });
          }
          continue;
        }

        if (reveal.phase === 3) {
          if (!meeting) {
            nextReveals.push(reveal);
            continue;
          }
          const timeText = formatMeetingTime(meeting.scheduledAt, timeZone);
          const location = meeting.location.name;
          const sent = await this.sendSms(
            state,
            `Here is the proposal: ${timeText} at ${location}. Reply YES to confirm, MOVE to reschedule, or CANCEL.`,
          );
          if (sent) {
            state.pendingMeetingConfirmation = meeting.meetingId;
            state.pendingMeetingConfirmationAt = now;
            state.pendingMeetingEscalatedAt = undefined;
            nextReveals.push({
              ...reveal,
              phase: 4,
              nextPhaseAt: now + delays[3],
            });
          }
          continue;
        }

        if (reveal.phase >= 4) {
          // Match reveal expired with no response - remove from reveals
          // The meeting escalation handler will notify admin if needed
          const expirationHours = parseNumber(
            process.env.SOULMATES_MATCH_REVEAL_EXPIRE_HOURS,
            48,
          );
          const expirationMs = expirationHours * 60 * 60 * 1000;

          if (now - reveal.nextPhaseAt > expirationMs) {
            // Send final reminder before expiring
            const sent = await this.sendSms(
              state,
              "I have not heard back about your match. Reply YES to confirm or I will move on to find you someone else.",
            );
            if (sent) {
              // Remove this expired reveal
              continue;
            }
          }
          // Keep the reveal if we couldn't send or it hasn't expired yet
          nextReveals.push(reveal);
        }
      }

      state.matchReveals = nextReveals;
      await saveUserState(state);
    }
  }

  private async handleMeetingEscalations(
    states: UserFlowState[],
  ): Promise<void> {
    const now = Date.now();
    const thresholdHours = parseNumber(
      process.env.SOULMATES_SCHEDULE_ESCALATION_HOURS,
      72,
    );
    const thresholdMs = thresholdHours * 60 * 60 * 1000;

    for (const state of states) {
      if (
        !state.pendingMeetingConfirmation ||
        !state.pendingMeetingConfirmationAt
      )
        continue;
      if (state.pendingMeetingEscalatedAt) continue;
      if (now - state.pendingMeetingConfirmationAt < thresholdMs) continue;

      await notifyAdmin(
        this.runtime,
        `Scheduling stalled for ${state.profile.fullName ?? "member"} (${state.entityId}). Please assist.`,
      );
      state.pendingMeetingEscalatedAt = now;
      await saveUserState(state);
    }
  }

  /**
   * Group Meeting Flow (Stage 4)
   * - Schedule users for group validation meetings
   * - Send reminders before group meetings
   * - Request feedback after group meetings
   * - Advance validated users to active status
   */
  private async handleGroupMeetings(states: UserFlowState[]): Promise<void> {
    const now = Date.now();
    const groupMeetingIso = process.env.SOULMATES_GROUP_MEETING_ISO;
    const feedbackDelayHours = parseNumber(
      process.env.SOULMATES_GROUP_FEEDBACK_DELAY_HOURS,
      2,
    );
    const feedbackDelayMs = feedbackDelayHours * 60 * 60 * 1000;
    const reminder24Ms = 24 * 60 * 60 * 1000;
    const reminder2Ms = 2 * 60 * 60 * 1000;
    const community =
      process.env.SOULMATES_DEFAULT_COMMUNITY ?? "your community";

    for (const state of states) {
      if (state.stage !== "group_meeting") continue;
      if (!state.groupMeeting) continue;

      const {
        status,
        scheduledAt,
        completedAt,
        reminderSentAt,
        feedbackRequestedAt,
        validated,
      } = state.groupMeeting;

      // If no scheduled time, try to schedule from env
      if (status === "pending" && groupMeetingIso) {
        const parsed = Date.parse(groupMeetingIso);
        if (Number.isFinite(parsed) && parsed > now) {
          state.groupMeeting.scheduledAt = parsed;
          state.groupMeeting.status = "scheduled";
          const timeText = formatMeetingTime(parsed, state.profile.timeZone);
          const locationName =
            process.env.SOULMATES_GROUP_MEETING_LOCATION_NAME ?? "TBD";
          const locationAddress =
            process.env.SOULMATES_GROUP_MEETING_LOCATION_ADDRESS ?? "";
          state.groupMeeting.locationName = locationName;
          state.groupMeeting.locationAddress = locationAddress;
          await this.sendSms(
            state,
            `Welcome to ${community}! Before we match you 1:1, please join our group intro on ${timeText} at ${locationName}. Reply YES to confirm.`,
          );
          await saveUserState(state);
          continue;
        }
      }

      // Send 24h reminder
      if (status === "scheduled" && scheduledAt && !reminderSentAt) {
        if (
          now >= scheduledAt - reminder24Ms &&
          now < scheduledAt - reminder2Ms
        ) {
          const timeText = formatMeetingTime(
            scheduledAt,
            state.profile.timeZone,
          );
          await this.sendSms(
            state,
            `Reminder: the group intro is tomorrow at ${timeText}. Looking forward to seeing you there!`,
          );
          state.groupMeeting.reminderSentAt = now;
          await saveUserState(state);
          continue;
        }
      }

      // Send 2h reminder
      if (status === "scheduled" && scheduledAt && reminderSentAt) {
        if (now >= scheduledAt - reminder2Ms && now < scheduledAt) {
          const timeText = formatMeetingTime(
            scheduledAt,
            state.profile.timeZone,
          );
          await this.sendSms(
            state,
            `Heads up: the group intro starts in about 2 hours (${timeText}). See you soon!`,
          );
          await saveUserState(state);
          continue;
        }
      }

      // Mark as completed after meeting time passes
      if (
        status === "scheduled" &&
        scheduledAt &&
        now >= scheduledAt &&
        !completedAt
      ) {
        state.groupMeeting.status = "completed";
        state.groupMeeting.completedAt = now;
        await saveUserState(state);
        continue;
      }

      // Request feedback after completion
      if (status === "completed" && completedAt && !feedbackRequestedAt) {
        if (now >= completedAt + feedbackDelayMs) {
          await this.sendSms(
            state,
            "How was the group intro? Reply with a rating 1-5, or reply SKIP if you could not attend.",
          );
          state.groupMeeting.feedbackRequestedAt = now;
          await saveUserState(state);
          continue;
        }
      }

      // Advance validated users to active (matching queue)
      if (
        status === "completed" &&
        validated &&
        state.stage === "group_meeting"
      ) {
        state.stage = "active";
        state.checkIn.status = "idle";
        state.checkIn.nextCheckInAt = now;
        await this.sendSms(
          state,
          "You are now in the matching pool! I will check in soon to find you someone great.",
        );
        await saveUserState(state);
      }
    }
  }

  /**
   * Reliability Coaching Flow
   * - Identify users with poor reliability scores
   * - Send gentle coaching messages
   * - Suggest ways to improve
   */
  private async handleReliabilityCoaching(
    states: UserFlowState[],
  ): Promise<void> {
    const now = Date.now();
    const lowReliabilityThreshold = parseNumber(
      process.env.SOULMATES_LOW_RELIABILITY_THRESHOLD,
      60,
    );
    const coachingIntervalDays = parseNumber(
      process.env.SOULMATES_RELIABILITY_COACHING_DAYS,
      14,
    );
    const coachingIntervalMs = coachingIntervalDays * 24 * 60 * 60 * 1000;
    const coolOffDays = parseNumber(
      process.env.SOULMATES_RELIABILITY_COOLOFF_DAYS,
      7,
    );
    const coolOffMs = coolOffDays * 24 * 60 * 60 * 1000;

    for (const state of states) {
      if (state.stage !== "active" && state.stage !== "matching_queue")
        continue;

      const { score, lastCoachedAt, lateCancelCount, noShowCount, ghostCount } =
        state.reliability;

      // Skip if already coached recently
      if (lastCoachedAt && now - lastCoachedAt < coachingIntervalMs) continue;

      // Check for poor reliability indicators
      const totalIssues = lateCancelCount + noShowCount + ghostCount;
      const needsCoaching = score < lowReliabilityThreshold || totalIssues >= 3;

      if (!needsCoaching) continue;

      // Determine the coaching message based on the primary issue
      let message: string;
      if (ghostCount >= 2) {
        message =
          "I noticed you have not responded to some recent matches. Life gets busy! If you need a break, just reply PAUSE and I will check back when you are ready.";
        state.stage = "paused";
        state.pausedAt = now;
        state.checkIn.status = "paused";
        state.checkIn.nextCheckInAt = now + coolOffMs;
      } else if (noShowCount >= 2) {
        message =
          "Missing meetings affects both you and your matches. If scheduling is tricky, let me know and I can help find better times. Reply READY when you want to try again.";
        state.stage = "paused";
        state.pausedAt = now;
        state.checkIn.status = "paused";
        state.checkIn.nextCheckInAt = now + coolOffMs;
      } else if (lateCancelCount >= 3) {
        message =
          "I see there have been some last-minute cancellations. That happens! If your schedule is unpredictable right now, reply PAUSE and I will reach out when things settle down.";
      } else {
        message =
          "Just checking in. If you are finding it hard to commit to meetings right now, that is okay. Reply PAUSE to take a break, or YES to keep going.";
      }

      await this.sendSms(state, message);
      state.reliability.lastCoachedAt = now;
      await saveUserState(state);
    }
  }

  /**
   * Graduated Reactivation Flow
   * - Send increasingly urgent reactivation messages to dormant users
   * - Track reactivation attempts
   * - Eventually pause users who don't respond
   */
  private async handleGraduatedReactivation(
    states: UserFlowState[],
  ): Promise<void> {
    const now = Date.now();
    const dormantDays = parseNumber(process.env.SOULMATES_DORMANT_DAYS, 14);
    const dormantMs = dormantDays * 24 * 60 * 60 * 1000;
    const reactivationIntervalDays = parseNumber(
      process.env.SOULMATES_REACTIVATION_INTERVAL_DAYS,
      7,
    );
    const reactivationIntervalMs =
      reactivationIntervalDays * 24 * 60 * 60 * 1000;
    const maxReactivationAttempts = parseNumber(
      process.env.SOULMATES_MAX_REACTIVATION_ATTEMPTS,
      3,
    );
    const community =
      process.env.SOULMATES_DEFAULT_COMMUNITY ?? "your community";

    for (const state of states) {
      // Only target active/matching_queue users who haven't interacted
      if (state.stage !== "active" && state.stage !== "matching_queue")
        continue;
      if (state.checkIn.status === "pending") continue; // Already checking in

      const lastInteraction = state.lastInteractionAt ?? 0;
      const timeSinceInteraction = now - lastInteraction;

      // Not dormant yet
      if (timeSinceInteraction < dormantMs) continue;

      const attempts = state.reactivationAttempts ?? 0;
      const lastAttemptAt = state.lastReactivationAttemptAt ?? 0;

      // Check if enough time has passed since last attempt
      if (lastAttemptAt && now - lastAttemptAt < reactivationIntervalMs)
        continue;

      // Max attempts reached - pause the user
      if (attempts >= maxReactivationAttempts) {
        await this.sendSms(
          state,
          "I have not heard from you in a while, so I will pause matching for now. When you are ready to reconnect, just reply READY.",
        );
        state.stage = "paused";
        state.pausedAt = now;
        state.checkIn.status = "paused";
        state.reactivationAttempts = 0;
        state.lastReactivationAttemptAt = undefined;
        await saveUserState(state);
        continue;
      }

      // Send graduated reactivation message
      const messages = [
        `Hi ${state.profile.fullName ?? "there"}! It has been a while. Ready to meet someone new from ${community}? Reply YES or LATER.`,
        `I miss you! There are some great people waiting to meet you. Reply YES to get matched, or PAUSE if you need more time.`,
        `Last chance before I pause your matching. Reply YES to stay active, LATER to hear from me soon, or PAUSE to take a break.`,
      ];

      const message = messages[Math.min(attempts, messages.length - 1)];
      await this.sendSms(state, message);

      state.reactivationAttempts = attempts + 1;
      state.lastReactivationAttemptAt = now;
      await saveUserState(state);
    }
  }

  private async handleMeetingReminders(
    states: UserFlowState[],
    engineState: EngineState,
    matchingService: MatchingService,
    reminderState: ReminderState,
  ): Promise<ReminderState> {
    const now = Date.now();
    const reminder24Ms = 24 * 60 * 60 * 1000;
    const reminder2Ms = 2 * 60 * 60 * 1000;
    const feedbackDelayMs =
      parseNumber(process.env.SOULMATES_FEEDBACK_DELAY_HOURS, 2) *
      60 *
      60 *
      1000;

    for (const meeting of engineState.meetings) {
      if (meeting.status !== "scheduled") {
        delete reminderState.reminders[meeting.meetingId];
        continue;
      }

      const scheduledAt = Date.parse(meeting.scheduledAt);
      if (!Number.isFinite(scheduledAt)) continue;
      const reminder = reminderState.reminders[meeting.meetingId] ?? {};
      const match = engineState.matches.find(
        (m) => m.matchId === meeting.matchId,
      );
      if (!match) continue;

      const entityA = await matchingService.getEntityForPersona(match.personaA);
      const entityB = await matchingService.getEntityForPersona(match.personaB);
      if (!entityA || !entityB) continue;
      const stateA = states.find((s) => s.entityId === entityA);
      const stateB = states.find((s) => s.entityId === entityB);
      if (!stateA || !stateB) continue;

      const personaA = getPersonaById(engineState, match.personaA);
      const timeZone = personaA?.profile.availability.timeZone ?? "UTC";
      const timeText = formatMeetingTime(meeting.scheduledAt, timeZone);

      if (
        !reminder.reminder24hSentAt &&
        now >= scheduledAt - reminder24Ms &&
        now < scheduledAt - reminder2Ms
      ) {
        const msg = `Reminder: your meeting is tomorrow at ${timeText}. Reply MOVE or CANCEL if needed. For safety, meet in a public place and text FLAG anytime.`;
        await Promise.all([
          this.sendSms(stateA, msg),
          this.sendSms(stateB, msg),
        ]);
        reminder.reminder24hSentAt = now;
      }

      if (
        !reminder.reminder2hSentAt &&
        now >= scheduledAt - reminder2Ms &&
        now < scheduledAt
      ) {
        const msg = `Heads up: your meeting is in about 2 hours (${timeText}). Reply MOVE or CANCEL if needed. For safety, meet in a public place and text FLAG anytime.`;
        await Promise.all([
          this.sendSms(stateA, msg),
          this.sendSms(stateB, msg),
        ]);
        reminder.reminder2hSentAt = now;
      }

      if (
        !reminder.feedbackPromptSentAt &&
        now >= scheduledAt + feedbackDelayMs
      ) {
        const msg = "How did the meeting go? Reply with a rating from 1-5.";
        if (!stateA.pendingFeedback) {
          stateA.pendingFeedback = {
            meetingId: meeting.meetingId,
            stage: "rating",
            askedAt: now,
          };
          await saveUserState(stateA);
        }
        if (!stateB.pendingFeedback) {
          stateB.pendingFeedback = {
            meetingId: meeting.meetingId,
            stage: "rating",
            askedAt: now,
          };
          await saveUserState(stateB);
        }
        await Promise.all([
          this.sendSms(stateA, msg),
          this.sendSms(stateB, msg),
        ]);
        reminder.feedbackPromptSentAt = now;
      }

      reminderState.reminders[meeting.meetingId] = reminder;
    }

    return reminderState;
  }

  private async loadReminderState(): Promise<ReminderState> {
    const component = await this.runtime.getComponent(
      this.runtime.agentId,
      REMINDER_COMPONENT,
    );
    const data = component?.data;
    const raw = data?.reminders;
    const reminders =
      raw && typeof raw === "object"
        ? (raw as Record<string, ReminderEntry>)
        : {};
    return { reminders };
  }

  private async saveReminderState(state: ReminderState): Promise<void> {
    const existing = await this.runtime.getComponent(
      this.runtime.agentId,
      REMINDER_COMPONENT,
    );
    const { roomId, worldId } = await ensureSystemContext(this.runtime);
    const { v4: uuidv4 } = await import("uuid");
    const resolvedWorldId =
      existing?.worldId && existing.worldId !== "" ? existing.worldId : worldId;
    const component = {
      id: existing?.id || (uuidv4() as UUID),
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: existing?.roomId ?? roomId,
      worldId: resolvedWorldId,
      sourceEntityId: this.runtime.agentId,
      type: REMINDER_COMPONENT,
      createdAt: existing?.createdAt || Date.now(),
      data: {
        reminders: state.reminders,
      },
    };
    if (existing) {
      await this.runtime.updateComponent(component);
    } else {
      await this.runtime.createComponent(component);
    }
  }
}

export const notificationServicePlugin: Plugin = {
  name: "soulmates-notifications",
  description: "Scheduling and notification loop for Soulmates",
  services: [NotificationService],
};

export default notificationServicePlugin;
