/**
 * Defines eliza-owned synthetic LifeOps benchmark contracts shaped after public
 * knowledge and voice-interruption benchmark methodology.
 */
import type { LifeWorldDocument } from "./lifeops-fake-backend.js";

export type SierraStyleFailureCategory =
  | "interruption_recovery"
  | "background_noise"
  | "dropped_frame"
  | "auth_code_spelling"
  | "email_spelling"
  | "multi_step_completion";

export interface SierraStyleKnowledgeFixture {
  id: string;
  methodology: {
    inspiration: "sierra_tau_knowledge";
    dataPolicy: "eliza_owned_synthetic_only";
    sourceData: "none";
  };
  world: LifeWorldDocument;
  userPrompt: string;
  requiredEndState: {
    calendarEvent: {
      title: string;
      start: string;
      end: string;
      attendees: string[];
    };
    draftEmail: {
      to: string;
      subjectIncludes: string;
      bodyIncludes: string[];
    };
    reminder: {
      title: string;
      dueAt: string;
    };
  };
}

export interface SierraStyleKnowledgeScore {
  pass: boolean;
  checks: {
    calendarEventCreated: boolean;
    draftEmailCreated: boolean;
    reminderCreated: boolean;
  };
}

export interface SierraStyleVoiceFixture {
  id: string;
  methodology: {
    inspiration: "sierra_tau_voice";
    dataPolicy: "eliza_owned_synthetic_only";
    sourceData: "none";
  };
  taskPrompt: string;
  simulation: {
    voiceProfile: string;
    turns: Array<{
      speaker: "user" | "assistant";
      text: string;
      interruptionAtMs?: number;
      background?: "none" | "cafe_babble" | "keyboard" | "fan_hvac";
      droppedFrameWindowsMs?: Array<[number, number]>;
    }>;
    authOrSpellingTargets: Array<{
      kind: "auth_code" | "email" | "proper_name";
      spoken: string;
      expectedNormalized: string;
    }>;
  };
  expectedReportFields: Array<keyof SierraStyleVoiceReport>;
  passCriteria: {
    passAt1: true;
    requiredFailureCategories: SierraStyleFailureCategory[];
    requiredManualReview: true;
  };
}

export interface SierraStyleVoiceReport {
  provider: string;
  model: string;
  voiceConfig: {
    stt: string;
    tts: string;
    vad: string;
    noiseProfile: string;
  };
  passAt1: boolean;
  recoveryCategories: SierraStyleFailureCategory[];
  manuallyReviewedOutputs: string[];
}

export function createSierraStyleKnowledgeFixture(): SierraStyleKnowledgeFixture {
  const world: LifeWorldDocument = {
    seed: 13361,
    now_iso: "2026-07-04T09:00:00Z",
    stores: {
      contact: {
        c_amelia: {
          id: "c_amelia",
          display_name: "Amelia Chen",
          given_name: "Amelia",
          family_name: "Chen",
          primary_email: "amelia.chen@example.test",
          phones: [],
          company: "Northstar Ops",
          role: "Launch reviewer",
          relationship: "work",
          importance: 9,
          tags: ["launch", "reviewer"],
          birthday: null,
        },
      },
      email: {
        e_launch: {
          id: "e_launch",
          thread_id: "thread_launch",
          folder: "inbox",
          from_email: "amelia.chen@example.test",
          to_emails: ["owner@example.test"],
          cc_emails: [],
          subject: "Launch packet review",
          body_plain:
            "Please book a 30 minute Blue Harbor launch review at 15:30 UTC on July 8 and send me a draft with the deck code BH-7421.",
          sent_at: "2026-07-04T08:45:00Z",
          received_at: "2026-07-04T08:45:00Z",
          is_read: false,
          is_starred: true,
          labels: ["launch"],
          attachments: [],
        },
      },
      email_thread: {
        thread_launch: {
          id: "thread_launch",
          subject: "Launch packet review",
          message_ids: ["e_launch"],
          participants: ["amelia.chen@example.test", "owner@example.test"],
          last_activity_at: "2026-07-04T08:45:00Z",
        },
      },
      chat_message: {},
      conversation: {},
      calendar_event: {
        ev_focus: {
          id: "ev_focus",
          calendar_id: "cal_primary",
          title: "Focus block",
          description: "",
          location: null,
          start: "2026-07-08T13:00:00Z",
          end: "2026-07-08T14:00:00Z",
          all_day: false,
          attendees: [],
          status: "confirmed",
          visibility: "default",
          recurrence_rule: null,
          source: "google",
        },
      },
      calendar: {
        cal_primary: {
          id: "cal_primary",
          name: "Work",
          color: "#4285F4",
          owner: "owner@example.test",
          source: "google",
          is_primary: true,
        },
      },
      reminder: {},
      reminder_list: {
        list_default: {
          id: "list_default",
          name: "Reminders",
          source: "apple-reminders",
        },
      },
      note: {
        note_launch_context: {
          id: "note_launch_context",
          title: "Blue Harbor launch context",
          body_markdown:
            "Blue Harbor review requires Amelia Chen, deck code BH-7421, and a same-day follow-up reminder.",
          tags: ["launch", "blue-harbor"],
          created_at: "2026-07-03T12:00:00Z",
          updated_at: "2026-07-03T12:00:00Z",
          source: "notes",
        },
      },
      transaction: {},
      account: {},
      subscription: {},
      health_metric: {},
      location_point: {},
    },
  };

  return {
    id: "sierra-style-knowledge-blue-harbor",
    methodology: {
      inspiration: "sierra_tau_knowledge",
      dataPolicy: "eliza_owned_synthetic_only",
      sourceData: "none",
    },
    world,
    userPrompt:
      "Use my current knowledge and inbox to prepare the Blue Harbor launch review.",
    requiredEndState: {
      calendarEvent: {
        title: "Blue Harbor launch review",
        start: "2026-07-08T15:30:00Z",
        end: "2026-07-08T16:00:00Z",
        attendees: ["amelia.chen@example.test"],
      },
      draftEmail: {
        to: "amelia.chen@example.test",
        subjectIncludes: "Blue Harbor",
        bodyIncludes: ["BH-7421", "15:30"],
      },
      reminder: {
        title: "Follow up on Blue Harbor launch review",
        dueAt: "2026-07-08T17:00:00Z",
      },
    },
  };
}

export function scoreSierraStyleKnowledgeFixture(
  fixture: SierraStyleKnowledgeFixture,
  world: LifeWorldDocument,
): SierraStyleKnowledgeScore {
  const calendarEventCreated = Object.values(world.stores.calendar_event).some(
    (event) =>
      event.status === "confirmed" &&
      event.title === fixture.requiredEndState.calendarEvent.title &&
      event.start === fixture.requiredEndState.calendarEvent.start &&
      event.end === fixture.requiredEndState.calendarEvent.end &&
      fixture.requiredEndState.calendarEvent.attendees.every((attendee) =>
        event.attendees.includes(attendee),
      ),
  );

  const draftEmailCreated = Object.values(world.stores.email).some(
    (email) =>
      email.folder === "drafts" &&
      email.to_emails.includes(fixture.requiredEndState.draftEmail.to) &&
      email.subject.includes(
        fixture.requiredEndState.draftEmail.subjectIncludes,
      ) &&
      fixture.requiredEndState.draftEmail.bodyIncludes.every((needle) =>
        email.body_plain.includes(needle),
      ),
  );

  const reminderCreated = Object.values(world.stores.reminder).some(
    (reminder) =>
      reminder.completed_at === null &&
      reminder.title === fixture.requiredEndState.reminder.title &&
      reminder.due_at === fixture.requiredEndState.reminder.dueAt,
  );

  return {
    pass: calendarEventCreated && draftEmailCreated && reminderCreated,
    checks: {
      calendarEventCreated,
      draftEmailCreated,
      reminderCreated,
    },
  };
}

export const SIERRA_STYLE_VOICE_INTERRUPTION_FIXTURE: SierraStyleVoiceFixture =
  {
    id: "sierra-style-voice-interruption-blue-harbor",
    methodology: {
      inspiration: "sierra_tau_voice",
      dataPolicy: "eliza_owned_synthetic_only",
      sourceData: "none",
    },
    taskPrompt:
      "Complete the Blue Harbor launch review setup while recovering from interruption, noise, dropped frames, and spelled credentials.",
    simulation: {
      voiceProfile: "synthetic-us-en-neutral-owner",
      turns: [
        {
          speaker: "user",
          text: "Schedule the Blue Harbor review with Amelia Chen next Wednesday at three thirty UTC.",
          background: "cafe_babble",
        },
        {
          speaker: "assistant",
          text: "I can set that up and draft the follow-up.",
          interruptionAtMs: 620,
        },
        {
          speaker: "user",
          text: "Wait, include the deck code B H seven four two one and email amelia dot chen at example dot test.",
          background: "keyboard",
          droppedFrameWindowsMs: [
            [1180, 1260],
            [2140, 2220],
          ],
        },
      ],
      authOrSpellingTargets: [
        {
          kind: "auth_code",
          spoken: "B H seven four two one",
          expectedNormalized: "BH-7421",
        },
        {
          kind: "email",
          spoken: "amelia dot chen at example dot test",
          expectedNormalized: "amelia.chen@example.test",
        },
        {
          kind: "proper_name",
          spoken: "Amelia Chen",
          expectedNormalized: "Amelia Chen",
        },
      ],
    },
    expectedReportFields: [
      "provider",
      "model",
      "voiceConfig",
      "passAt1",
      "recoveryCategories",
      "manuallyReviewedOutputs",
    ],
    passCriteria: {
      passAt1: true,
      requiredFailureCategories: [
        "interruption_recovery",
        "background_noise",
        "dropped_frame",
        "auth_code_spelling",
        "email_spelling",
        "multi_step_completion",
      ],
      requiredManualReview: true,
    },
  };

export function validateSierraStyleVoiceReport(
  fixture: SierraStyleVoiceFixture,
  report: SierraStyleVoiceReport,
): string[] {
  const errors: string[] = [];
  if (!report.provider.trim()) errors.push("provider is required");
  if (!report.model.trim()) errors.push("model is required");
  if (!report.voiceConfig.stt.trim())
    errors.push("voiceConfig.stt is required");
  if (!report.voiceConfig.tts.trim())
    errors.push("voiceConfig.tts is required");
  if (!report.voiceConfig.vad.trim())
    errors.push("voiceConfig.vad is required");
  if (!report.voiceConfig.noiseProfile.trim()) {
    errors.push("voiceConfig.noiseProfile is required");
  }
  if (report.passAt1 !== fixture.passCriteria.passAt1) {
    errors.push("passAt1 must be true for this fixture");
  }
  for (const category of fixture.passCriteria.requiredFailureCategories) {
    if (!report.recoveryCategories.includes(category)) {
      errors.push(`missing recovery category: ${category}`);
    }
  }
  if (
    fixture.passCriteria.requiredManualReview &&
    report.manuallyReviewedOutputs.length === 0
  ) {
    errors.push("manuallyReviewedOutputs must include at least one artifact");
  }
  return errors;
}
