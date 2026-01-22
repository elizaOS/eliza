/** Component-based persistence for scheduling data using ElizaOS Components */

import type { Component, IAgentRuntime, Metadata, UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type { Availability, Meeting, Reminder, SchedulingRequest } from "./types.js";

const SCHEDULING_AVAILABILITY = "scheduling_availability";
const SCHEDULING_MEETING = "scheduling_meeting";
const SCHEDULING_REMINDER = "scheduling_reminder";
const SCHEDULING_REQUEST = "scheduling_request";
const SCHEDULING_MEETING_INDEX_ROOM = "scheduling_meeting_index:room";
const SCHEDULING_MEETING_INDEX_PARTICIPANT = "scheduling_meeting_index:participant";
const SCHEDULING_REMINDER_INDEX_MEETING = "scheduling_reminder_index:meeting";

interface MeetingIndex {
  meetingIds: string[];
}
interface ReminderIndex {
  reminderIds: string[];
}

async function getMeetingIndex(
  runtime: IAgentRuntime,
  indexType: string,
  indexKey: string
): Promise<MeetingIndex> {
  const componentType = `${indexType}:${indexKey}`;
  // Use agent's entityId for global indices
  const component = await runtime.getComponent(runtime.agentId, componentType);
  if (!component) {
    return { meetingIds: [] };
  }
  return component.data as unknown as MeetingIndex;
}

async function saveMeetingIndex(
  runtime: IAgentRuntime,
  indexType: string,
  indexKey: string,
  index: MeetingIndex
): Promise<void> {
  const componentType = `${indexType}:${indexKey}`;
  const existing = await runtime.getComponent(runtime.agentId, componentType);

  const component: Component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: uuidv4() as UUID,
    worldId: existing?.worldId || (uuidv4() as UUID),
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: existing?.createdAt || Date.now(),
    data: index as unknown as Metadata,
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }
}

async function addToMeetingIndex(
  runtime: IAgentRuntime,
  indexType: string,
  indexKey: string,
  meetingId: string
): Promise<void> {
  const index = await getMeetingIndex(runtime, indexType, indexKey);
  if (!index.meetingIds.includes(meetingId)) {
    index.meetingIds.push(meetingId);
    await saveMeetingIndex(runtime, indexType, indexKey, index);
  }
}

async function removeFromMeetingIndex(
  runtime: IAgentRuntime,
  indexType: string,
  indexKey: string,
  meetingId: string
): Promise<void> {
  const index = await getMeetingIndex(runtime, indexType, indexKey);
  index.meetingIds = index.meetingIds.filter((id) => id !== meetingId);
  await saveMeetingIndex(runtime, indexType, indexKey, index);
}

async function getReminderIndex(runtime: IAgentRuntime, meetingId: string): Promise<ReminderIndex> {
  const componentType = `${SCHEDULING_REMINDER_INDEX_MEETING}:${meetingId}`;
  const component = await runtime.getComponent(runtime.agentId, componentType);
  return component ? (component.data as unknown as ReminderIndex) : { reminderIds: [] };
}

async function saveReminderIndex(
  runtime: IAgentRuntime,
  meetingId: string,
  index: ReminderIndex
): Promise<void> {
  const componentType = `${SCHEDULING_REMINDER_INDEX_MEETING}:${meetingId}`;
  const existing = await runtime.getComponent(runtime.agentId, componentType);

  const component: Component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: uuidv4() as UUID,
    worldId: existing?.worldId || (uuidv4() as UUID),
    sourceEntityId: runtime.agentId,
    type: componentType,
    createdAt: existing?.createdAt || Date.now(),
    data: index as unknown as Metadata,
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }
}

export interface AvailabilityStorage {
  get(entityId: UUID): Promise<Availability | null>;
  save(entityId: UUID, availability: Availability): Promise<void>;
  delete(entityId: UUID): Promise<void>;
}

export const getAvailabilityStorage = (runtime: IAgentRuntime): AvailabilityStorage => ({
  get: async (entityId) => {
    const componentType = `${SCHEDULING_AVAILABILITY}:${entityId}`;
    const component = await runtime.getComponent(entityId, componentType);
    if (!component) return null;
    return component.data as unknown as Availability;
  },

  save: async (entityId, availability) => {
    const componentType = `${SCHEDULING_AVAILABILITY}:${entityId}`;
    const existing = await runtime.getComponent(entityId, componentType);

    const component: Component = {
      id: existing?.id || (uuidv4() as UUID),
      entityId,
      agentId: runtime.agentId,
      roomId: uuidv4() as UUID,
      worldId: existing?.worldId || (uuidv4() as UUID),
      sourceEntityId: runtime.agentId,
      type: componentType,
      createdAt: existing?.createdAt || Date.now(),
      data: availability as unknown as Metadata,
    };

    if (existing) {
      await runtime.updateComponent(component);
    } else {
      await runtime.createComponent(component);
    }
  },

  delete: async (entityId) => {
    const componentType = `${SCHEDULING_AVAILABILITY}:${entityId}`;
    const existing = await runtime.getComponent(entityId, componentType);
    if (existing) {
      await runtime.deleteComponent(existing.id);
    }
  },
});

export interface SchedulingRequestStorage {
  get(requestId: string): Promise<SchedulingRequest | null>;
  save(request: SchedulingRequest): Promise<void>;
  delete(requestId: string): Promise<void>;
  getByRoom(roomId: UUID): Promise<SchedulingRequest[]>;
}

export const getSchedulingRequestStorage = (runtime: IAgentRuntime): SchedulingRequestStorage => ({
  get: async (requestId) => {
    const componentType = `${SCHEDULING_REQUEST}:${requestId}`;
    const component = await runtime.getComponent(runtime.agentId, componentType);
    if (!component) return null;
    return component.data as unknown as SchedulingRequest;
  },

  save: async (request) => {
    const componentType = `${SCHEDULING_REQUEST}:${request.id}`;
    const existing = await runtime.getComponent(runtime.agentId, componentType);

    const component: Component = {
      id: existing?.id || (uuidv4() as UUID),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: request.roomId,
      worldId: existing?.worldId || (uuidv4() as UUID),
      sourceEntityId: runtime.agentId,
      type: componentType,
      createdAt: existing?.createdAt || Date.now(),
      data: request as unknown as Metadata,
    };

    if (existing) {
      await runtime.updateComponent(component);
    } else {
      await runtime.createComponent(component);
    }
  },

  delete: async (requestId) => {
    const componentType = `${SCHEDULING_REQUEST}:${requestId}`;
    const existing = await runtime.getComponent(runtime.agentId, componentType);
    if (existing) {
      await runtime.deleteComponent(existing.id);
    }
  },

  getByRoom: async (roomId) => {
    const components = await runtime.getComponents(runtime.agentId);
    const requests: SchedulingRequest[] = [];
    for (const component of components) {
      if (component.type.startsWith(`${SCHEDULING_REQUEST}:`)) {
        const request = component.data as unknown as SchedulingRequest;
        if (request.roomId === roomId) requests.push(request);
      }
    }
    return requests;
  },
});

export interface MeetingStorage {
  get(meetingId: string): Promise<Meeting | null>;
  save(meeting: Meeting): Promise<void>;
  delete(meetingId: string): Promise<void>;
  getByRoom(roomId: UUID): Promise<Meeting[]>;
  getUpcomingForParticipant(entityId: UUID): Promise<Meeting[]>;
}

export const getMeetingStorage = (runtime: IAgentRuntime): MeetingStorage => ({
  get: async (meetingId) => {
    const componentType = `${SCHEDULING_MEETING}:${meetingId}`;
    const component = await runtime.getComponent(runtime.agentId, componentType);
    if (!component) return null;
    return component.data as unknown as Meeting;
  },

  save: async (meeting) => {
    const componentType = `${SCHEDULING_MEETING}:${meeting.id}`;
    const existing = await runtime.getComponent(runtime.agentId, componentType);

    const component: Component = {
      id: existing?.id || (uuidv4() as UUID),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: meeting.roomId,
      worldId: existing?.worldId || (uuidv4() as UUID),
      sourceEntityId: runtime.agentId,
      type: componentType,
      createdAt: existing?.createdAt || meeting.createdAt,
      data: meeting as unknown as Metadata,
    };

    if (existing) {
      await runtime.updateComponent(component);
    } else {
      await runtime.createComponent(component);

      // Add to room index
      await addToMeetingIndex(runtime, SCHEDULING_MEETING_INDEX_ROOM, meeting.roomId, meeting.id);

      // Add to participant indices
      for (const participant of meeting.participants) {
        await addToMeetingIndex(
          runtime,
          SCHEDULING_MEETING_INDEX_PARTICIPANT,
          participant.entityId,
          meeting.id
        );
      }
    }
  },

  delete: async (meetingId) => {
    const componentType = `${SCHEDULING_MEETING}:${meetingId}`;
    const existing = await runtime.getComponent(runtime.agentId, componentType);

    if (existing) {
      const meeting = existing.data as unknown as Meeting;

      // Remove from room index
      await removeFromMeetingIndex(
        runtime,
        SCHEDULING_MEETING_INDEX_ROOM,
        meeting.roomId,
        meetingId
      );

      // Remove from participant indices
      for (const participant of meeting.participants) {
        await removeFromMeetingIndex(
          runtime,
          SCHEDULING_MEETING_INDEX_PARTICIPANT,
          participant.entityId,
          meetingId
        );
      }

      await runtime.deleteComponent(existing.id);
    }
  },

  getByRoom: async (roomId) => {
    const index = await getMeetingIndex(runtime, SCHEDULING_MEETING_INDEX_ROOM, roomId);
    const meetings: Meeting[] = [];

    for (const meetingId of index.meetingIds) {
      const componentType = `${SCHEDULING_MEETING}:${meetingId}`;
      const component = await runtime.getComponent(runtime.agentId, componentType);
      if (component) {
        meetings.push(component.data as unknown as Meeting);
      }
    }

    return meetings;
  },

  getUpcomingForParticipant: async (entityId) => {
    const index = await getMeetingIndex(runtime, SCHEDULING_MEETING_INDEX_PARTICIPANT, entityId);
    const meetings: Meeting[] = [];
    const now = Date.now();

    for (const meetingId of index.meetingIds) {
      const componentType = `${SCHEDULING_MEETING}:${meetingId}`;
      const component = await runtime.getComponent(runtime.agentId, componentType);
      if (component) {
        const meeting = component.data as unknown as Meeting;
        // Only include upcoming, non-cancelled meetings
        if (new Date(meeting.slot.start).getTime() > now && meeting.status !== "cancelled") {
          meetings.push(meeting);
        }
      }
    }

    // Sort by start time
    meetings.sort((a, b) => new Date(a.slot.start).getTime() - new Date(b.slot.start).getTime());

    return meetings;
  },
});

export interface ReminderStorage {
  get(reminderId: string): Promise<Reminder | null>;
  save(reminder: Reminder): Promise<void>;
  delete(reminderId: string): Promise<void>;
  getByMeeting(meetingId: string): Promise<Reminder[]>;
  getDue(): Promise<Reminder[]>;
}

const REMINDER_REGISTRY = "scheduling_reminder_registry";
interface ReminderRegistry {
  reminderIds: string[];
}

async function getReminderRegistry(runtime: IAgentRuntime): Promise<ReminderRegistry> {
  const component = await runtime.getComponent(runtime.agentId, REMINDER_REGISTRY);
  if (!component) {
    return { reminderIds: [] };
  }
  return component.data as unknown as ReminderRegistry;
}

async function saveReminderRegistry(
  runtime: IAgentRuntime,
  registry: ReminderRegistry
): Promise<void> {
  const existing = await runtime.getComponent(runtime.agentId, REMINDER_REGISTRY);

  const component: Component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: uuidv4() as UUID,
    worldId: existing?.worldId || (uuidv4() as UUID),
    sourceEntityId: runtime.agentId,
    type: REMINDER_REGISTRY,
    createdAt: existing?.createdAt || Date.now(),
    data: registry as unknown as Metadata,
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }
}

export const getReminderStorage = (runtime: IAgentRuntime): ReminderStorage => ({
  get: async (reminderId) => {
    const componentType = `${SCHEDULING_REMINDER}:${reminderId}`;
    const component = await runtime.getComponent(runtime.agentId, componentType);
    if (!component) return null;
    return component.data as unknown as Reminder;
  },

  save: async (reminder) => {
    const componentType = `${SCHEDULING_REMINDER}:${reminder.id}`;
    const existing = await runtime.getComponent(runtime.agentId, componentType);

    const component: Component = {
      id: existing?.id || (uuidv4() as UUID),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: uuidv4() as UUID,
      worldId: existing?.worldId || (uuidv4() as UUID),
      sourceEntityId: runtime.agentId,
      type: componentType,
      createdAt: existing?.createdAt || reminder.createdAt,
      data: reminder as unknown as Metadata,
    };

    if (existing) {
      await runtime.updateComponent(component);
    } else {
      await runtime.createComponent(component);

      // Add to meeting index
      const index = await getReminderIndex(runtime, reminder.meetingId);
      if (!index.reminderIds.includes(reminder.id)) {
        index.reminderIds.push(reminder.id);
        await saveReminderIndex(runtime, reminder.meetingId, index);
      }

      // Add to global registry for getDue queries
      const registry = await getReminderRegistry(runtime);
      if (!registry.reminderIds.includes(reminder.id)) {
        registry.reminderIds.push(reminder.id);
        await saveReminderRegistry(runtime, registry);
      }
    }
  },

  delete: async (reminderId) => {
    const componentType = `${SCHEDULING_REMINDER}:${reminderId}`;
    const existing = await runtime.getComponent(runtime.agentId, componentType);

    if (existing) {
      const reminder = existing.data as unknown as Reminder;

      // Remove from meeting index
      const index = await getReminderIndex(runtime, reminder.meetingId);
      index.reminderIds = index.reminderIds.filter((id) => id !== reminderId);
      await saveReminderIndex(runtime, reminder.meetingId, index);

      // Remove from global registry
      const registry = await getReminderRegistry(runtime);
      registry.reminderIds = registry.reminderIds.filter((id) => id !== reminderId);
      await saveReminderRegistry(runtime, registry);

      await runtime.deleteComponent(existing.id);
    }
  },

  getByMeeting: async (meetingId) => {
    const index = await getReminderIndex(runtime, meetingId);
    const reminders: Reminder[] = [];

    for (const reminderId of index.reminderIds) {
      const componentType = `${SCHEDULING_REMINDER}:${reminderId}`;
      const component = await runtime.getComponent(runtime.agentId, componentType);
      if (component) {
        reminders.push(component.data as unknown as Reminder);
      }
    }

    return reminders;
  },

  getDue: async () => {
    const registry = await getReminderRegistry(runtime);
    const now = Date.now();
    const dueReminders: Reminder[] = [];

    for (const reminderId of registry.reminderIds) {
      const componentType = `${SCHEDULING_REMINDER}:${reminderId}`;
      const component = await runtime.getComponent(runtime.agentId, componentType);

      if (component) {
        const reminder = component.data as unknown as Reminder;
        if (reminder.status === "pending" && new Date(reminder.scheduledFor).getTime() <= now) {
          dueReminders.push(reminder);
        }
      }
    }

    return dueReminders;
  },
});
