# @elizaos/plugin-scheduling

Scheduling and calendar coordination plugin for ElizaOS agents.

## Features

- **Multi-party Availability Coordination**: Find meeting times that work for all participants
- **Time Zone Aware**: Handles availability across different time zones
- **Calendar Invites**: Generate ICS files for calendar integration
- **Automated Reminders**: Schedule SMS/email reminders before meetings
- **Meeting Lifecycle**: Track meetings from proposal to completion
- **Rescheduling Support**: Handle cancellations and reschedules gracefully

## Installation

```bash
npm install @elizaos/plugin-scheduling
```

## Usage

```typescript
import { schedulingPlugin } from '@elizaos/plugin-scheduling';
import { createCharacter } from '@elizaos/core';

const character = createCharacter({
  name: 'Scheduler',
  plugins: [schedulingPlugin],
});
```

## API

### SchedulingService

The core service for managing scheduling operations.

#### Save Availability

```typescript
const schedulingService = runtime.getService<SchedulingService>('SCHEDULING');

await schedulingService.saveAvailability(entityId, {
  timeZone: 'America/New_York',
  weekly: [
    { day: 'mon', startMinutes: 540, endMinutes: 1020 }, // 9am-5pm
    { day: 'tue', startMinutes: 540, endMinutes: 1020 },
    { day: 'wed', startMinutes: 540, endMinutes: 1020 },
    { day: 'thu', startMinutes: 540, endMinutes: 1020 },
    { day: 'fri', startMinutes: 540, endMinutes: 1020 },
  ],
  exceptions: [
    { date: '2024-01-20', unavailable: true, reason: 'Holiday' },
  ],
});
```

#### Create Scheduling Request

```typescript
const request = await schedulingService.createSchedulingRequest(
  roomId,
  'Coffee Chat',
  [
    { entityId: user1Id, name: 'Alice', availability: aliceAvailability },
    { entityId: user2Id, name: 'Bob', availability: bobAvailability },
  ],
  {
    minDurationMinutes: 30,
    preferredDurationMinutes: 60,
    maxDaysOut: 7,
    preferredTimes: ['afternoon'],
    locationType: 'in_person',
  }
);
```

#### Find Available Slots

```typescript
const result = await schedulingService.findAvailableSlots(request);

if (result.success) {
  // result.proposedSlots contains ranked time slots
  const bestSlot = result.proposedSlots[0];
  console.log(`Best slot: ${bestSlot.slot.start} - Score: ${bestSlot.score}`);
}
```

#### Create Meeting

```typescript
const meeting = await schedulingService.createMeeting(request, slot, {
  type: 'in_person',
  name: 'Blue Bottle Coffee',
  address: '123 Main St',
  city: 'San Francisco',
});
```

#### Confirm Attendance

```typescript
await schedulingService.confirmParticipant(meetingId, entityId);
```

### Actions

The plugin provides conversational actions:

- `SCHEDULE_MEETING`: Start scheduling a meeting
- `CONFIRM_MEETING`: Confirm or decline attendance
- `SET_AVAILABILITY`: Update availability preferences

### Provider

The `SCHEDULING_CONTEXT` provider gives agents context about:
- Upcoming meetings
- Pending confirmations
- User's availability settings

## Types

### Availability

```typescript
interface Availability {
  timeZone: string;               // IANA time zone
  weekly: AvailabilityWindow[];   // Recurring windows
  exceptions: AvailabilityException[]; // One-off changes
}

interface AvailabilityWindow {
  day: DayOfWeek;       // 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
  startMinutes: number; // Minutes from midnight (0-1439)
  endMinutes: number;   // Minutes from midnight (0-1439)
}
```

### Meeting

```typescript
interface Meeting {
  id: string;
  title: string;
  slot: TimeSlot;
  location: MeetingLocation;
  participants: MeetingParticipant[];
  status: MeetingStatus;
  rescheduleCount: number;
}

type MeetingStatus = 
  | 'proposed'
  | 'confirmed'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'rescheduling'
  | 'no_show';
```

## Configuration

```typescript
const config: SchedulingServiceConfig = {
  defaultReminderMinutes: [1440, 120],  // 24h and 2h before
  maxProposals: 3,
  defaultMaxDaysOut: 7,
  minMeetingDuration: 30,
  defaultMeetingDuration: 60,
  autoSendCalendarInvites: true,
  autoScheduleReminders: true,
};
```

## Calendar Integration

Generate ICS files for calendar apps:

```typescript
import { generateIcs } from '@elizaos/plugin-scheduling';

const ics = generateIcs({
  uid: meeting.id,
  title: meeting.title,
  start: meeting.slot.start,
  end: meeting.slot.end,
  timeZone: meeting.slot.timeZone,
  location: meeting.location.address,
  organizer: { name: 'Ori', email: 'ori@soulmates.app' },
  attendees: meeting.participants.map(p => ({
    name: p.name,
    email: p.email,
    role: p.role,
  })),
  reminderMinutes: [1440, 120],
});
```

## License

MIT
