import type {
  EngineState,
  MatchRecord,
  MeetingRecord,
  MessageChannel,
  MessageLog,
  MessageStatus,
  Persona,
  PersonaId,
} from "@engine/types";
import { getUsersByPersonaIds } from "@/lib/engine-store";
import { readEnv } from "@/lib/env";
import {
  type OutboundChannel,
  sendOutboundMessage,
} from "@/lib/twilio-messaging";

export type NotificationResult = {
  state: EngineState;
  sent: number;
  failed: number;
  skipped: number;
};

export type MatchNotificationOptions = {
  channel: OutboundChannel;
};

export type ReminderOptions = {
  channel: OutboundChannel;
  windowsMinutes: number[];
  toleranceMinutes: number;
  now: Date;
};

export type MatchRevealOptions = {
  channel: OutboundChannel;
  phase2Hours: number;
  phase3Hours: number;
  phase4Hours: number;
  now: Date;
};

const buildMatchMessage = (name: string, interest: string): string =>
  `Hi ${name}, Ori found someone who shares ${interest}. Want to see where this goes? Reply YES to continue.`;

const buildReminderMessage = (
  name: string,
  meeting: MeetingRecord,
  timeText: string,
): string => {
  const location = meeting.location;
  const locationText =
    location.address !== "TBD"
      ? `${location.name} (${location.address})`
      : location.name;
  return `Reminder ${name}: your Ori meetup is ${timeText} at ${locationText}. Reply MOVE to reschedule. For safety, meet in a public place and text FLAG anytime.`;
};

const getPersonaName = (persona: Persona): string =>
  persona.profile.name || persona.general.name || "there";

const getSharedInterest = (persona: Persona, partner: Persona): string => {
  const set = new Set(
    persona.profile.interests.map((value) => value.toLowerCase()),
  );
  const shared = partner.profile.interests.find((value) =>
    set.has(value.toLowerCase()),
  );
  return shared ?? "something you both care about";
};

const formatMeetingTime = (
  meeting: MeetingRecord,
  persona: Persona,
): string => {
  const timeZone = persona.profile.availability.timeZone || "UTC";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return formatter.format(new Date(meeting.scheduledAt));
};

const hasMessage = (state: EngineState, messageId: string): boolean =>
  state.messages.some((entry) => entry.messageId === messageId);

const getMessage = (state: EngineState, messageId: string): MessageLog | null =>
  state.messages.find((entry) => entry.messageId === messageId) ?? null;

const logMessage = (
  state: EngineState,
  message: {
    messageId: string;
    personaId: PersonaId;
    channel: MessageChannel;
    text: string;
    status: MessageStatus;
  },
): void => {
  const entry: MessageLog = {
    messageId: message.messageId,
    personaId: message.personaId,
    direction: "outbound",
    channel: message.channel,
    text: message.text,
    createdAt: new Date().toISOString(),
    status: message.status,
  };
  state.messages.push(entry);
};

const resolveChannel = (channel: OutboundChannel): MessageChannel =>
  channel === "whatsapp" ? "whatsapp" : "sms";

export async function sendMatchNotifications(
  state: EngineState,
  matches: MatchRecord[],
  options: MatchNotificationOptions,
): Promise<NotificationResult> {
  if (matches.length === 0) {
    return { state, sent: 0, failed: 0, skipped: 0 };
  }
  const personaIds = uniquePersonaIds(matches);
  const users = await getUsersByPersonaIds(personaIds);
  const userMap = new Map<PersonaId, { phone: string; name: string | null }>();
  for (const user of users) {
    userMap.set(user.personaId, { phone: user.phone, name: user.name });
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const match of matches) {
    const participants: PersonaId[] = [match.personaA, match.personaB];
    for (const personaId of participants) {
      const messageId = `match:phase1:${match.matchId}:${personaId}`;
      if (hasMessage(state, messageId)) {
        skipped += 1;
        continue;
      }

      const persona = state.personas.find((p) => p.id === personaId);
      const partnerId =
        personaId === match.personaA ? match.personaB : match.personaA;
      const partner = state.personas.find((p) => p.id === partnerId);
      if (!persona) {
        skipped += 1;
        continue;
      }
      if (!partner) {
        skipped += 1;
        continue;
      }

      const user = userMap.get(personaId);
      if (!user) {
        skipped += 1;
        continue;
      }

      const name = getPersonaName(persona);
      const interest = getSharedInterest(persona, partner);
      const text = buildMatchMessage(name, interest);
      try {
        await sendOutboundMessage({
          to: user.phone,
          body: text,
          channel: options.channel,
        });
        logMessage(state, {
          messageId,
          personaId,
          channel: resolveChannel(options.channel),
          text,
          status: "sent",
        });
        sent += 1;
      } catch (_err) {
        logMessage(state, {
          messageId,
          personaId,
          channel: resolveChannel(options.channel),
          text,
          status: "failed",
        });
        failed += 1;
      }
    }
  }

  return { state, sent, failed, skipped };
}

export async function sendMeetingReminders(
  state: EngineState,
  options: ReminderOptions,
): Promise<NotificationResult> {
  const windows = options.windowsMinutes;
  if (windows.length === 0) {
    return { state, sent: 0, failed: 0, skipped: 0 };
  }

  const personaIds = uniquePersonaIdsFromMeetings(state);
  const users = await getUsersByPersonaIds(personaIds);
  const userMap = new Map<PersonaId, string>();
  for (const user of users) {
    userMap.set(user.personaId, user.phone);
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const meeting of state.meetings) {
    if (meeting.status !== "scheduled") continue;
    const match = state.matches.find(
      (entry) => entry.matchId === meeting.matchId,
    );
    if (!match) continue;
    const participants: PersonaId[] = [match.personaA, match.personaB];
    const minutesUntil = Math.round(
      (new Date(meeting.scheduledAt).getTime() - options.now.getTime()) / 60000,
    );

    for (const window of windows) {
      if (Math.abs(minutesUntil - window) > options.toleranceMinutes) {
        continue;
      }

      for (const personaId of participants) {
        const messageId = `reminder:${window}:${meeting.meetingId}:${personaId}`;
        if (hasMessage(state, messageId)) {
          skipped += 1;
          continue;
        }
        const persona = state.personas.find((p) => p.id === personaId);
        const phone = userMap.get(personaId);
        if (!persona || !phone) {
          skipped += 1;
          continue;
        }

        const timeText = formatMeetingTime(meeting, persona);
        const text = buildReminderMessage(
          getPersonaName(persona),
          meeting,
          timeText,
        );

        try {
          await sendOutboundMessage({
            to: phone,
            body: text,
            channel: options.channel,
          });
          logMessage(state, {
            messageId,
            personaId,
            channel: resolveChannel(options.channel),
            text,
            status: "sent",
          });
          sent += 1;
        } catch (_err) {
          logMessage(state, {
            messageId,
            personaId,
            channel: resolveChannel(options.channel),
            text,
            status: "failed",
          });
          failed += 1;
        }
      }
    }
  }

  return { state, sent, failed, skipped };
}

export async function sendMatchReveals(
  state: EngineState,
  options: MatchRevealOptions,
): Promise<NotificationResult> {
  const personaIds = uniquePersonaIds(state.matches);
  const users = await getUsersByPersonaIds(personaIds);
  const userMap = new Map<PersonaId, { phone: string; name: string | null }>();
  for (const user of users) {
    userMap.set(user.personaId, { phone: user.phone, name: user.name });
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const match of state.matches) {
    if (match.status === "canceled" || match.status === "expired") continue;
    const meeting = match.scheduledMeetingId
      ? state.meetings.find(
          (entry) => entry.meetingId === match.scheduledMeetingId,
        )
      : undefined;

    for (const personaId of [match.personaA, match.personaB]) {
      const persona = state.personas.find((p) => p.id === personaId);
      const partnerId =
        personaId === match.personaA ? match.personaB : match.personaA;
      const partner = state.personas.find((p) => p.id === partnerId);
      const user = userMap.get(personaId);
      if (!persona || !partner || !user) {
        skipped += 1;
        continue;
      }

      const phase1Id = `match:phase1:${match.matchId}:${personaId}`;
      const phase1 = getMessage(state, phase1Id);
      if (!phase1) {
        continue;
      }

      const phase1At = Date.parse(phase1.createdAt);
      if (!Number.isFinite(phase1At)) {
        skipped += 1;
        continue;
      }

      const phase2Id = `match:phase2:${match.matchId}:${personaId}`;
      const phase2 = getMessage(state, phase2Id);
      if (
        !phase2 &&
        options.now.getTime() - phase1At >= options.phase2Hours * 60 * 60 * 1000
      ) {
        const timeText = meeting ? formatMeetingTime(meeting, persona) : "soon";
        const text = `Your schedules line up around ${timeText}. Want me to make an intro? Reply INTRO.`;
        try {
          await sendOutboundMessage({
            to: user.phone,
            body: text,
            channel: options.channel,
          });
          logMessage(state, {
            messageId: phase2Id,
            personaId,
            channel: resolveChannel(options.channel),
            text,
            status: "sent",
          });
          sent += 1;
        } catch {
          logMessage(state, {
            messageId: phase2Id,
            personaId,
            channel: resolveChannel(options.channel),
            text,
            status: "failed",
          });
          failed += 1;
        }
        continue;
      }

      const phase3Id = `match:phase3:${match.matchId}:${personaId}`;
      const phase3 = getMessage(state, phase3Id);
      const phase2At = phase2 ? Date.parse(phase2.createdAt) : null;
      if (
        phase2 &&
        !phase3 &&
        phase2At &&
        options.now.getTime() - phase2At >= options.phase3Hours * 60 * 60 * 1000
      ) {
        const text =
          "I can share a warm intro and open a group chat. Reply INTRO to continue.";
        try {
          await sendOutboundMessage({
            to: user.phone,
            body: text,
            channel: options.channel,
          });
          logMessage(state, {
            messageId: phase3Id,
            personaId,
            channel: resolveChannel(options.channel),
            text,
            status: "sent",
          });
          sent += 1;
        } catch {
          logMessage(state, {
            messageId: phase3Id,
            personaId,
            channel: resolveChannel(options.channel),
            text,
            status: "failed",
          });
          failed += 1;
        }
        continue;
      }

      const phase4Id = `match:phase4:${match.matchId}:${personaId}`;
      const phase4 = getMessage(state, phase4Id);
      const phase3At = phase3 ? Date.parse(phase3.createdAt) : null;
      if (
        phase3 &&
        !phase4 &&
        phase3At &&
        meeting &&
        options.now.getTime() - phase3At >= options.phase4Hours * 60 * 60 * 1000
      ) {
        const timeText = formatMeetingTime(meeting, persona);
        const location = meeting.location.name;
        const text = `Here is a proposal: ${timeText} at ${location}. Reply YES to confirm, MOVE to reschedule, or CANCEL.`;
        try {
          await sendOutboundMessage({
            to: user.phone,
            body: text,
            channel: options.channel,
          });
          logMessage(state, {
            messageId: phase4Id,
            personaId,
            channel: resolveChannel(options.channel),
            text,
            status: "sent",
          });
          sent += 1;
        } catch {
          logMessage(state, {
            messageId: phase4Id,
            personaId,
            channel: resolveChannel(options.channel),
            text,
            status: "failed",
          });
          failed += 1;
        }
      }
    }
  }

  return { state, sent, failed, skipped };
}

const uniquePersonaIds = (matches: MatchRecord[]): PersonaId[] => {
  const set = new Set<PersonaId>();
  for (const match of matches) {
    set.add(match.personaA);
    set.add(match.personaB);
  }
  return Array.from(set);
};

const uniquePersonaIdsFromMeetings = (state: EngineState): PersonaId[] => {
  const set = new Set<PersonaId>();
  for (const meeting of state.meetings) {
    const match = state.matches.find(
      (entry) => entry.matchId === meeting.matchId,
    );
    if (!match) continue;
    set.add(match.personaA);
    set.add(match.personaB);
  }
  return Array.from(set);
};

const resolveDefaultChannel = (): OutboundChannel => {
  const channel = readEnv("SOULMATES_MATCHING_CHANNEL");
  return channel === "whatsapp" ? "whatsapp" : "sms";
};

export const getDefaultNotificationChannel = (): OutboundChannel =>
  resolveDefaultChannel();
