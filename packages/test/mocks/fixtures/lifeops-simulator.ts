export const LIFEOPS_SIMULATOR_CHANNELS = [
  "discord",
  "telegram",
  "signal",
  "whatsapp",
  "imessage",
] as const;

export type LifeOpsSimulatorChannel =
  (typeof LIFEOPS_SIMULATOR_CHANNELS)[number];

export interface LifeOpsSimulatorPerson {
  key: string;
  name: string;
  email: string;
  phone: string;
  signalNumber: string;
  whatsappNumber: string;
  telegramUsername: string;
  telegramPeerId: string;
  discordChannelId: string;
  discordUsername: string;
}

export interface LifeOpsSimulatorEmail {
  id: string;
  threadId: string;
  fromPersonKey: string;
  subject: string;
  snippet: string;
  bodyText: string;
  labels: string[];
  internalDateOffsetMs: number;
  accountId?: "work" | "home";
}

export interface LifeOpsSimulatorCalendarEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  startOffsetMs: number;
  durationMs: number;
  attendeePersonKeys: string[];
}

export interface LifeOpsSimulatorChannelMessage {
  id: string;
  channel: LifeOpsSimulatorChannel;
  threadId: string;
  threadName: string;
  threadType: "dm" | "group";
  fromPersonKey: string;
  text: string;
  sentAtOffsetMs: number;
  unread?: boolean;
  outgoing?: boolean;
}

export interface LifeOpsSimulatorReminder {
  id: string;
  title: string;
  description: string;
  dueOffsetMs: number;
  channel: LifeOpsSimulatorChannel;
}

export const LIFEOPS_SIMULATOR_OWNER = {
  name: "Eliza Test Owner",
  email: "owner@example.test",
  homeEmail: "owner.home@example.test",
  phone: "+15550000000",
  timezone: "America/Los_Angeles",
} as const;

export const LIFEOPS_SIMULATOR_OWNER_IDENTITIES = {
  telegram: {
    id: "lifeops-simulator-owner",
    username: "mocked_lifeops_owner",
    firstName: "Eliza",
  },
  signal: {
    uuid: "lifeops-simulator-signal-owner",
    deviceName: "LifeOps Simulator Signal",
  },
  discord: {
    id: "lifeops-simulator-owner",
    username: "mocked_owner",
    discriminator: "0001",
  },
  whatsapp: {
    businessAccountId: "lifeops-simulator-whatsapp",
    phoneNumberId: "lifeops-simulator-whatsapp-phone",
  },
} as const;

export const LIFEOPS_SIMULATOR_PEOPLE: LifeOpsSimulatorPerson[] = [
  {
    key: "alice",
    name: "Alice Nguyen",
    email: "alice.nguyen@example.test",
    phone: "+15551112222",
    signalNumber: "+15551110001",
    whatsappNumber: "+15551118888",
    telegramUsername: "alice_ops",
    telegramPeerId: "7001001",
    discordChannelId: "111",
    discordUsername: "alice_ops",
  },
  {
    key: "bob",
    name: "Bob Martinez",
    email: "bob.martinez@example.test",
    phone: "+15552223333",
    signalNumber: "+15551110002",
    whatsappNumber: "+15552228888",
    telegramUsername: "bob_builder",
    telegramPeerId: "7001002",
    discordChannelId: "222",
    discordUsername: "bob_builder",
  },
  {
    key: "priya",
    name: "Priya Shah",
    email: "priya.shah@example.test",
    phone: "+15553334444",
    signalNumber: "+15551110003",
    whatsappNumber: "+15553338888",
    telegramUsername: "priya_sched",
    telegramPeerId: "7001003",
    discordChannelId: "333",
    discordUsername: "priya_sched",
  },
  {
    key: "marco",
    name: "Marco Alvarez",
    email: "marco.alvarez@example.test",
    phone: "+15554445555",
    signalNumber: "+15551110004",
    whatsappNumber: "+15554448888",
    telegramUsername: "marco_ops",
    telegramPeerId: "7001004",
    discordChannelId: "444",
    discordUsername: "marco_ops",
  },
];

export const LIFEOPS_SIMULATOR_EMAILS: LifeOpsSimulatorEmail[] = [
  {
    id: "sim-email-alice-meeting",
    threadId: "sim-thread-alice-meeting",
    fromPersonKey: "alice",
    subject: "Project Atlas request to meet Thursday",
    snippet: "Could we meet Thursday at 10:30 to resolve the launch checklist?",
    bodyText:
      "Hey,\n\nCould we meet Thursday at 10:30 to resolve the Project Atlas launch checklist? I also dropped a note in Telegram so you can confirm wherever is easiest.\n\nAlice\n",
    labels: ["INBOX", "UNREAD", "IMPORTANT"],
    internalDateOffsetMs: -35 * 60 * 1000,
  },
  {
    id: "sim-email-priya-calendar",
    threadId: "sim-thread-priya-calendar",
    fromPersonKey: "priya",
    subject: "Calendar invite needs attendee list",
    snippet: "Please add Bob and Marco before the investor diligence review.",
    bodyText:
      "Can you add Bob and Marco to the investor diligence review invite before noon? The group chat is waiting on the attendee list.\n",
    labels: ["INBOX", "UNREAD"],
    internalDateOffsetMs: -80 * 60 * 1000,
  },
  {
    id: "sim-email-marco-followup",
    threadId: "sim-thread-marco-followup",
    fromPersonKey: "marco",
    subject: "Diligence packet comments before the call",
    snippet:
      "Can you send comments on the diligence packet before our calendar item?",
    bodyText:
      "Please send comments on the diligence packet before our calendar item. Priya said Signal is the fastest fallback if email gets buried.\n",
    labels: ["INBOX", "UNREAD", "IMPORTANT"],
    internalDateOffsetMs: -2 * 60 * 60 * 1000,
  },
];

export const LIFEOPS_SIMULATOR_CALENDAR_EVENTS: LifeOpsSimulatorCalendarEvent[] =
  [
    {
      id: "sim-cal-project-atlas",
      title: "Project Atlas working session",
      description:
        "Requested by Alice over email and Telegram. Resolve launch checklist and attendee owners.",
      location: "Google Meet",
      startOffsetMs: 26 * 60 * 60 * 1000,
      durationMs: 45 * 60 * 1000,
      attendeePersonKeys: ["alice", "bob"],
    },
    {
      id: "sim-cal-investor-diligence",
      title: "Investor diligence review",
      description:
        "Review packet comments from Marco and Priya before sending the follow-up.",
      location: "Zoom",
      startOffsetMs: 4 * 60 * 60 * 1000,
      durationMs: 30 * 60 * 1000,
      attendeePersonKeys: ["priya", "marco"],
    },
    {
      id: "sim-cal-dentist",
      title: "Dentist cleaning",
      description: "Synthetic personal appointment from the home mailbox.",
      location: "Downtown Dental",
      startOffsetMs: 3 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000,
      durationMs: 60 * 60 * 1000,
      attendeePersonKeys: [],
    },
  ];

export const LIFEOPS_SIMULATOR_CHANNEL_MESSAGES: LifeOpsSimulatorChannelMessage[] =
  [
    {
      id: "sim-telegram-alice-1",
      channel: "telegram",
      threadId: "tg-alice",
      threadName: "Alice Nguyen",
      threadType: "dm",
      fromPersonKey: "alice",
      text: "I sent the Project Atlas meeting request by email too. Thursday 10:30 still works if you can confirm.",
      sentAtOffsetMs: -30 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-telegram-atlas-group-1",
      channel: "telegram",
      threadId: "tg-atlas-launch",
      threadName: "Atlas Launch Room",
      threadType: "group",
      fromPersonKey: "bob",
      text: "Can someone check whether Marco is on the calendar invite?",
      sentAtOffsetMs: -25 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-discord-alice-1",
      channel: "discord",
      threadId: "111",
      threadName: "Alice Nguyen",
      threadType: "dm",
      fromPersonKey: "alice",
      text: "ProjectAtlas timeline slipped again. Can you review the launch checklist before the standup?",
      sentAtOffsetMs: -28 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-discord-atlas-group-1",
      channel: "discord",
      threadId: "atlas-launch",
      threadName: "Atlas Launch Room",
      threadType: "group",
      fromPersonKey: "priya",
      text: "Group chat reminder: investor diligence review starts after lunch.",
      sentAtOffsetMs: -16 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-signal-alice-1",
      channel: "signal",
      threadId: "+15551110001",
      threadName: "Alice Signal",
      threadType: "dm",
      fromPersonKey: "alice",
      text: "Signal check: are we still meeting after the calendar invite?",
      sentAtOffsetMs: -22 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-signal-ops-group-1",
      channel: "signal",
      threadId: "group-signal-atlas",
      threadName: "Atlas Signal Group",
      threadType: "group",
      fromPersonKey: "bob",
      text: "Reminder from Signal group: vendor call starts in 20 minutes.",
      sentAtOffsetMs: -18 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-whatsapp-priya-1",
      channel: "whatsapp",
      threadId: "+15553338888",
      threadName: "Priya Shah",
      threadType: "dm",
      fromPersonKey: "priya",
      text: "WhatsApp ping: please add Bob and Marco to the invite before noon.",
      sentAtOffsetMs: -20 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-whatsapp-atlas-group-1",
      channel: "whatsapp",
      threadId: "whatsapp-group-atlas-ops",
      threadName: "Atlas WhatsApp Group",
      threadType: "group",
      fromPersonKey: "marco",
      text: "WhatsApp group note: Alice asked whether the diligence packet is ready before the 3pm review.",
      sentAtOffsetMs: -14 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-imessage-alice-1",
      channel: "imessage",
      threadId: "iMessage;-;+15551112222",
      threadName: "Alice iMessage",
      threadType: "dm",
      fromPersonKey: "alice",
      text: "Can you review the Project Atlas note I sent across email and Telegram?",
      sentAtOffsetMs: -24 * 60 * 1000,
      unread: true,
    },
    {
      id: "sim-imessage-atlas-group-1",
      channel: "imessage",
      threadId: "iMessage;-;chat-atlas-ops",
      threadName: "Atlas iMessage Group",
      threadType: "group",
      fromPersonKey: "bob",
      text: "iMessage group check: can you confirm the calendar hold and remind Marco about the packet?",
      sentAtOffsetMs: -12 * 60 * 1000,
      unread: true,
    },
  ];

export const LIFEOPS_SIMULATOR_REMINDERS: LifeOpsSimulatorReminder[] = [
  {
    id: "sim-reminder-atlas-deck",
    title: "Review Project Atlas launch checklist",
    description:
      "Mock reminder tied to Alice's email, Telegram, Discord, and iMessage messages.",
    dueOffsetMs: 90 * 60 * 1000,
    channel: "telegram",
  },
  {
    id: "sim-reminder-investor-comments",
    title: "Send diligence packet comments",
    description:
      "Mock reminder tied to Marco and Priya's email and calendar thread.",
    dueOffsetMs: 3 * 60 * 60 * 1000,
    channel: "signal",
  },
];

export function getLifeOpsSimulatorPerson(key: string): LifeOpsSimulatorPerson {
  const person = LIFEOPS_SIMULATOR_PEOPLE.find(
    (candidate) => candidate.key === key,
  );
  if (!person) {
    throw new Error(`Unknown LifeOps simulator person: ${key}`);
  }
  return person;
}

export function lifeOpsSimulatorMessageTime(
  offsetMs: number,
  now = Date.now(),
): string {
  return new Date(now + offsetMs).toISOString();
}

export function lifeOpsSimulatorSummary() {
  return {
    owner: LIFEOPS_SIMULATOR_OWNER,
    people: LIFEOPS_SIMULATOR_PEOPLE.length,
    emails: LIFEOPS_SIMULATOR_EMAILS.length,
    calendarEvents: LIFEOPS_SIMULATOR_CALENDAR_EVENTS.length,
    channelMessages: LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.length,
    reminders: LIFEOPS_SIMULATOR_REMINDERS.length,
    channels: [
      ...new Set(LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.map((m) => m.channel)),
    ],
  };
}

export function assertLifeOpsSimulatorFixtureIntegrity(): void {
  const peopleByKey = new Map<string, LifeOpsSimulatorPerson>();
  const simulatorChannels = new Set<LifeOpsSimulatorChannel>(
    LIFEOPS_SIMULATOR_CHANNELS,
  );
  for (const person of LIFEOPS_SIMULATOR_PEOPLE) {
    if (peopleByKey.has(person.key)) {
      throw new Error(`Duplicate LifeOps simulator person key: ${person.key}`);
    }
    peopleByKey.set(person.key, person);
  }

  const requirePerson = (key: string, owner: string) => {
    if (!peopleByKey.has(key)) {
      throw new Error(
        `${owner} references unknown LifeOps simulator person: ${key}`,
      );
    }
  };

  for (const email of LIFEOPS_SIMULATOR_EMAILS) {
    requirePerson(email.fromPersonKey, `email ${email.id}`);
  }

  for (const event of LIFEOPS_SIMULATOR_CALENDAR_EVENTS) {
    for (const key of event.attendeePersonKeys) {
      requirePerson(key, `calendar event ${event.id}`);
    }
  }

  for (const message of LIFEOPS_SIMULATOR_CHANNEL_MESSAGES) {
    if (!simulatorChannels.has(message.channel)) {
      throw new Error(
        `LifeOps simulator message references unknown channel: ${message.id}`,
      );
    }
    requirePerson(message.fromPersonKey, `message ${message.id}`);
    if (!message.threadId.trim()) {
      throw new Error(
        `LifeOps simulator message has empty threadId: ${message.id}`,
      );
    }
    if (!message.text.trim()) {
      throw new Error(
        `LifeOps simulator message has empty text: ${message.id}`,
      );
    }
    if (message.outgoing === true) {
      throw new Error(
        `LifeOps simulator passive message cannot be outgoing: ${message.id}`,
      );
    }
  }

  for (const reminder of LIFEOPS_SIMULATOR_REMINDERS) {
    if (!simulatorChannels.has(reminder.channel)) {
      throw new Error(
        `Reminder ${reminder.id} references unknown channel: ${reminder.channel}`,
      );
    }
  }

  for (const channel of LIFEOPS_SIMULATOR_CHANNELS) {
    const messages = LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
      (message) => message.channel === channel,
    );
    if (!messages.some((message) => message.threadType === "dm")) {
      throw new Error(
        `LifeOps simulator channel lacks a DM fixture: ${channel}`,
      );
    }
    if (!messages.some((message) => message.threadType === "group")) {
      throw new Error(
        `LifeOps simulator channel lacks a group fixture: ${channel}`,
      );
    }
  }
}
