/** Exercises Stage-1 candidate admission and terminal replies through the real parsers without model transport. */

import type { Action } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { routeMessageHandlerOutput } from "../runtime/message-handler.ts";
import { retrieveContextualPlannerActions } from "./message/action-surface.ts";
import { inferDirectCurrentRequestCandidateInference } from "./message/direct-action-heuristics.ts";
import { parseMessageHandlerModelOutput } from "./message/stage1-generation.ts";
import { inferDirectCurrentRequestCandidateInference as inferRoutedCandidates } from "./message/stage1-reply-policy.ts";
import {
  collectBudgetedStageOneCandidateActions,
  messageHandlerFromFieldResult,
} from "./message.ts";

const actions: Action[] = [
  {
    name: "PAGE",
    description: "Page operations",
    subActions: ["GO", "READ_PAGE"],
  },
  { name: "GO", description: "Navigate" },
  { name: "READ_PAGE", description: "Read the loaded page" },
  { name: "UNRELATED", description: "Another domain" },
];

describe("budgeted model-selected action surface", () => {
  it.each([
    "Create /tmp/index.html with supplied HTML. Read the file back.",
    "Create the directory and index.html with the exact provided HTML. Read the saved file back and report its exact contents.",
  ])(
    "keeps resolved files work out of legacy coding rescue: %s",
    (messageText) => {
      const available: Action[] = [
        {
          name: "FILE",
          description: "Read and write local files",
          contexts: ["files"],
          tags: ["resource:files"],
          parameters: [],
        },
        {
          name: "TASKS",
          description: "Delegate coding work",
          contexts: ["code"],
          tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
          subActions: ["TASKS_CREATE", "TASKS_LIST_AGENTS"],
        },
        {
          name: "TASKS_CREATE",
          description: "Create a delegated task",
          contexts: ["code"],
        },
        {
          name: "TASKS_LIST_AGENTS",
          description: "List coding agents",
          contexts: ["code"],
        },
      ];
      const envelope = {
        shouldRespond: "RESPOND",
        contexts: ["files"],
        intents: [
          "Create the directory and index.html with the exact provided HTML",
          "Read the file back and report its exact contents",
        ],
        replyText: "On it.",
        replyEffectStatus: "pending",
        facts: [],
        relationships: [],
        addressedTo: [],
      };
      for (const parsed of [
        messageHandlerFromFieldResult(envelope, undefined, {
          actions: available,
          messageText,
        }),
        parseMessageHandlerModelOutput(JSON.stringify(envelope), {
          actions: available,
          messageText,
        }),
      ]) {
        expect(parsed?.plan.contexts).toEqual(["files"]);
        expect(parsed?.plan.intents).toEqual(envelope.intents);
        expect(parsed?.plan.candidateActions ?? []).toEqual([]);
        expect(
          inferRoutedCandidates(available, messageText, parsed?.plan.contexts)
            .names,
        ).toEqual([]);
        const selected = retrieveContextualPlannerActions({
          actions: available,
          query: messageText,
          contexts: parsed?.plan.contexts,
          intents: parsed?.plan.intents,
        });
        expect(selected.actions.map((action) => action.name)).toEqual(["FILE"]);
      }
    },
  );
  it.each(["general", "simple", "code"])(
    "retains legacy coding rescue for %s routing",
    (context) => {
      const available = [
        {
          name: "TASKS",
          tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
        },
      ];
      const result = messageHandlerFromFieldResult(
        {
          shouldRespond: "RESPOND",
          contexts: [context],
          intents: ["Create the file"],
          replyText: "On it.",
          replyEffectStatus: "pending",
        },
        undefined,
        { actions: available, messageText: "Create the file." },
      );
      expect(result.plan.candidateActions).toContain("TASKS");
    },
  );
  it("preserves explicit delegation and exact hints despite a files context", () => {
    const available = [
      {
        name: "TASKS",
        tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
      },
    ];
    const envelope = {
      shouldRespond: "RESPOND",
      contexts: ["files"],
      intents: ["Create the file"],
      replyText: "On it.",
      replyEffectStatus: "pending",
    };
    expect(
      messageHandlerFromFieldResult(
        { ...envelope, candidateActionNames: ["TASKS"] },
        undefined,
        { actions: available, messageText: "Create the file." },
      ).plan.candidateActions,
    ).toContain("TASKS");
    expect(
      inferRoutedCandidates(
        available,
        "Spawn a coding agent to create the file.",
        ["files"],
      ).names,
    ).toEqual(["TASKS"]);
  });

  it.each(["none", "non_applied"] as const)(
    "keeps an explicit %s acknowledgement out of inferred app work",
    (replyEffectStatus) => {
      const envelope = {
        shouldRespond: "RESPOND",
        contexts: ["simple"],
        intents: [],
        candidateActionNames: [],
        replyText: "Got it.",
        replyEffectStatus,
        facts: [],
        relationships: [],
        addressedTo: [],
      };
      const runtime = {
        actions: [
          { name: "VIEWS", tags: ["views", "app", "notes", "calendar"] },
          { name: "APP", tags: ["app", "apps"] },
        ],
        messageText:
          "This is only an acknowledgement, with no app action or saved-record changes. Reply exactly: Got it.",
      };
      for (const result of [
        messageHandlerFromFieldResult(envelope, undefined, runtime),
        parseMessageHandlerModelOutput(JSON.stringify(envelope), runtime),
      ]) {
        expect(result?.plan.requiresTool).not.toBe(true);
        expect(result?.plan.candidateActions ?? []).toEqual([]);
        expect(result?.plan.reply).toBe("Got it.");
      }
    },
  );
  it.each([
    { candidates: ["DISCOVER_ACTIONS"] },
    { candidates: ["DISCOVER_ACTIONS", "NOTES"] },
    { candidates: ["DISCOVER_TOOLS"] },
    { candidates: ["DISCOVER_TOOLS", "NOTES"] },
  ])(
    "retains framework discovery hints before the planner registers them: %j",
    ({ candidates }) => {
      const result = messageHandlerFromFieldResult(
        {
          shouldRespond: "RESPOND",
          contexts: ["general"],
          intents: ["inspect tool schemas"],
          candidateActionNames: candidates,
          replyText: "Discovering NOTES.",
          replyEffectStatus: "pending",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
        undefined,
        {
          actions: [
            {
              name: "VIEWS",
              tags: [
                "views",
                "ui",
                "panel",
                "view-capability",
                "notes",
                "calendar",
              ],
            },
            { name: "NOTES" },
          ],
          messageText:
            "Technical QA: use DISCOVER_TOOLS to discover the NOTES family by its exact name. Tell me which note operations it exposes. Do not create, edit, delete, or navigate.",
        },
      );
      expect(result.plan.candidateActions).toEqual(candidates);
      expect(result.plan.requiresTool).toBe(true);
      // Native and text envelopes take the separate legacy backstop before
      // field parsing. Exercise that actual live dispatch path as well.
      const envelope = {
        shouldRespond: "RESPOND",
        contexts: ["general"],
        intents: ["inspect tools"],
        candidateActionNames: candidates,
        replyText: "Discovering NOTES.",
        replyEffectStatus: "pending",
      };
      const runtime = {
        actions: [
          {
            name: "VIEWS",
            tags: [
              "views",
              "ui",
              "panel",
              "view-capability",
              "notes",
              "calendar",
            ],
          },
          { name: "NOTES" },
        ],
        messageText:
          "Discover NOTES. Do not create, edit, delete, or navigate.",
      };
      expect(
        inferDirectCurrentRequestCandidateInference(
          runtime.actions,
          runtime.messageText,
        ).names,
      ).toContain("VIEWS");
      expect(
        parseMessageHandlerModelOutput(JSON.stringify(envelope), runtime)?.plan
          .candidateActions,
      ).toEqual(candidates);
      expect(
        parseMessageHandlerModelOutput(
          {
            text: "",
            toolCalls: [
              {
                id: "stage1",
                name: "HANDLE_RESPONSE",
                arguments: envelope,
              },
            ],
          },
          runtime,
        )?.plan.candidateActions,
      ).toEqual(candidates);
    },
  );
  it.each([
    "One quick conversation test: use Spanish for the next note confirmation only. Do not save that preference; just keep it in this conversation.",
    "Do not save it.",
  ])(
    "does not override a model-classified no-save conversation: %s",
    (text) => {
      const reply =
        "Noted — when the next note confirmation comes up, I'll do it in Spanish for just that one, no saved preference.";
      const result = messageHandlerFromFieldResult(
        {
          shouldRespond: "RESPOND",
          contexts: ["simple"],
          intents: [],
          candidateActionNames: [],
          replyText: reply,
          replyEffectStatus: "none",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
        undefined,
        { actions: [{ name: "OWNER_GOALS" }], messageText: text },
      );

      expect(result.plan.simple).toBe(true);
      expect(result.plan.requiresTool).toBe(false);
      expect(result.plan.candidateActions ?? []).toEqual([]);
      expect(result.plan.reply).toBe(reply);
    },
  );

  it.each([
    { name: "pending effect", fields: { replyEffectStatus: "pending" } },
    { name: "applied effect", fields: { replyEffectStatus: "applied" } },
    {
      name: "model-selected goal action",
      fields: { candidateActionNames: ["OWNER_GOALS"] },
    },
    { name: "declared goal intent", fields: { intents: ["save the goal"] } },
    { name: "non-simple context", fields: { contexts: ["general"] } },
    {
      name: "legacy missing effect status",
      fields: { replyEffectStatus: undefined },
    },
    { name: "progress-only reply", fields: { replyText: "On it." } },
    { name: "empty reply", fields: { replyText: "" } },
  ])("preserves goal planning for $name", ({ fields }) => {
    const result = messageHandlerFromFieldResult(
      {
        shouldRespond: "RESPOND",
        contexts: ["simple"],
        intents: [],
        candidateActionNames: [],
        replyText: "Your goal belongs in your owner goals.",
        replyEffectStatus: "none",
        facts: [],
        relationships: [],
        addressedTo: [],
        ...fields,
      },
      undefined,
      {
        actions: [{ name: "OWNER_GOALS" }],
        messageText: "Save that goal.",
      },
    );

    expect(result.plan.simple).toBe(false);
    expect(result.plan.requiresTool).toBe(true);
    expect(result.plan.candidateActions).toContain("OWNER_GOALS");
  });

  it("preserves the model's complete intent list in the planner handoff", () => {
    const intents = [
      "open notes",
      "update the note body",
      "preserve its title",
    ];
    const result = messageHandlerFromFieldResult({
      shouldRespond: "RESPOND",
      contexts: ["notes"],
      intents,
      candidateActionNames: ["VIEWS", "NOTES"],
      replyText: "",
      facts: [],
      relationships: [],
      addressedTo: [],
    });
    expect(result.plan.intents).toEqual(intents);
  });
  it("defers broad context matches when complete other families remain discoverable", () => {
    const catalog: Action[] = [
      {
        name: "NOTES",
        description: "Saved notes",
        contexts: ["notes"],
        subActions: ["NOTES_LIST"],
      },
      { name: "NOTES_LIST", description: "Read notes", contexts: ["notes"] },
      { name: "DOCUMENT", description: "Documents", contexts: ["documents"] },
      { name: "FILES", description: "Files", contexts: ["documents"] },
    ];
    expect(
      collectBudgetedStageOneCandidateActions({
        actions: catalog,
        candidateActions: ["NOTES_LIST"],
        contexts: ["general", "documents"],
        deferUnselectedContexts: true,
      }).map((a) => a.name),
    ).toEqual(["NOTES_LIST"]);
    // Legacy budget recovery has no discovery guarantee and retains fallback.
    expect(
      collectBudgetedStageOneCandidateActions({
        actions: catalog,
        candidateActions: ["NOTES_LIST"],
        contexts: ["documents"],
      }).map((a) => a.name),
    ).toEqual(["NOTES", "NOTES_LIST", "DOCUMENT", "FILES"]);
  });

  it("retains a selected child's authorized umbrella without exposing unrelated domains", () => {
    expect(
      collectBudgetedStageOneCandidateActions({
        actions,
        candidateActions: ["GO"],
        contexts: [],
      }).map((action) => action.name),
    ).toEqual(["PAGE", "GO", "READ_PAGE"]);
  });

  it("does not reintroduce a gated parent or infer one from name prefixes", () => {
    expect(
      collectBudgetedStageOneCandidateActions({
        actions: actions.filter((action) => action.name !== "PAGE"),
        candidateActions: ["READ_PAGE"],
        contexts: [],
      }).map((action) => action.name),
    ).toEqual(["READ_PAGE"]);
  });

  it("keeps known families discoverable when another candidate is unresolved", () => {
    expect(
      collectBudgetedStageOneCandidateActions({
        actions,
        candidateActions: ["GO", "MISSING_CAPABILITY"],
        contexts: [],
      }),
    ).toEqual(actions.slice(0, 3));
    expect(
      collectBudgetedStageOneCandidateActions({
        actions,
        candidateActions: ["MISSING_CAPABILITY"],
        contexts: [],
      }),
    ).toEqual([]);
  });

  it.each(["HOME", "home"])(
    "resolves the model's %s destination hint alongside admitted navigation",
    (homeHint) => {
      const navigationActions: Action[] = [
        { name: "VIEWS", description: "Navigate to an authorized app view" },
        { name: "CALENDAR", description: "Manage calendar events" },
      ];
      expect(
        collectBudgetedStageOneCandidateActions({
          actions: navigationActions,
          candidateActions: [homeHint, "VIEWS"],
          contexts: ["general"],
        }).map((action) => action.name),
      ).toEqual(["VIEWS"]);
      expect(
        collectBudgetedStageOneCandidateActions({
          actions: navigationActions,
          candidateActions: ["HOME", "MISSING_CAPABILITY"],
          contexts: ["general"],
        }),
      ).toEqual([navigationActions[0]]);
      expect(
        collectBudgetedStageOneCandidateActions({
          actions: navigationActions.filter(
            (action) => action.name !== "VIEWS",
          ),
          candidateActions: ["HOME"],
          contexts: ["general"],
        }),
      ).toEqual([]);
    },
  );

  it("prefers a genuinely registered HOME action over the destination alias", () => {
    const home: Action = {
      name: "HOME",
      description: "A registered domain action",
    };
    expect(
      collectBudgetedStageOneCandidateActions({
        actions: [home, { name: "VIEWS", description: "Navigate" }],
        candidateActions: ["HOME"],
        contexts: [],
      }),
    ).toEqual([home]);
  });

  it("retains model-selected domain actions when a synthetic candidate aliases to navigation", () => {
    expect(
      collectBudgetedStageOneCandidateActions({
        actions: [
          { name: "VIEWS", description: "Navigation" },
          {
            name: "NOTES",
            description: "Note data",
            contexts: ["notes", "general"],
          },
          {
            name: "CALENDAR",
            description: "Events",
            contexts: ["calendar", "general"],
          },
        ],
        candidateActions: ["VIEWS", "NOTES_CREATE_NOTE"],
        contexts: ["notes", "general"],
      }).map((action) => action.name),
    ).toEqual(["VIEWS", "NOTES"]);
  });

  it("does not broaden the surface based on generic or current-page contexts", () => {
    expect(
      collectBudgetedStageOneCandidateActions({
        actions: [
          ...actions,
          { name: "GENERIC", description: "General", contexts: ["general"] },
          {
            name: "PAGE_ONLY",
            description: "Page",
            contexts: ["page", "page-notes"],
          },
        ],
        candidateActions: ["GO"],
        contexts: ["general", "page", "page-notes"],
      }).map((action) => action.name),
    ).toEqual(["PAGE", "GO", "READ_PAGE"]);
  });

  it("does not expand a resolved Calendar candidate to every action sharing its context", () => {
    const calendarActions: Action[] = [
      { name: "VIEWS", description: "Navigation", contexts: ["general"] },
      {
        name: "CALENDAR",
        description: "Calendar",
        contexts: ["calendar", "tasks"],
      },
      {
        name: "OWNER_ROUTINES",
        description: "Routines",
        contexts: ["calendar"],
      },
      {
        name: "OWNER_DOCUMENTS",
        description: "Documents",
        contexts: ["calendar"],
      },
    ];
    expect(
      collectBudgetedStageOneCandidateActions({
        actions: calendarActions,
        candidateActions: ["VIEWS", "CALENDAR"],
        contexts: ["calendar"],
      }).map((action) => action.name),
    ).toEqual(["VIEWS", "CALENDAR"]);
  });
});

describe("answered arithmetic routing", () => {
  const available = [{ name: "CALCULATE" }];
  const answered = {
    shouldRespond: "RESPOND",
    contexts: ["simple"],
    intents: [],
    replyText: "15.",
    replyEffectStatus: "none",
    facts: [],
    relationships: [],
    addressedTo: [],
  };
  it.each([
    "Hello Eliza, this is a voice development check. What is 7 plus 8? Please answer briefly.",
    "What is 7 plus 8? Do not use tools.",
    "Do not ever use tools; what is 7 plus 8?",
    "Never actually use a calculator; what is 7 plus 8?",
    "What is 7 plus 8? Don't use a calculator.",
    "What is 7 plus 8? Do not use the CALCULATE tool.",
  ])("preserves a complete simple arithmetic answer: %s", (messageText) => {
    for (const result of [
      messageHandlerFromFieldResult(answered, undefined, {
        actions: available,
        messageText,
      }),
      parseMessageHandlerModelOutput(JSON.stringify(answered), {
        actions: available,
        messageText,
      }),
    ]) {
      if (!result) throw new Error("Missing parsed response");
      expect(routeMessageHandlerOutput(result)).toMatchObject({
        type: "final_reply",
        reply: "15.",
      });
      expect(result.plan.requiresTool).not.toBe(true);
      expect(result?.plan.contexts).toEqual(["simple"]);
      expect(result?.plan.candidateActions ?? []).toEqual([]);
      expect(result?.plan.reply).toBe("15.");
    }
  });
  it.each([
    { messageText: "Use a calculator for 7 plus 8.", fields: {} },
    { messageText: "Call CALCULATE for 7 plus 8.", fields: {} },
    { messageText: "Use a tool to calculate 7 plus 8.", fields: {} },
    {
      messageText: "What is 7 plus 8?",
      fields: { contexts: ["general"], intents: ["Compute the sum"] },
    },
    {
      messageText: "What is 7 plus 8?",
      fields: { candidateActionNames: ["CALCULATE"] },
    },
    {
      messageText: "What is 7 plus 8?",
      fields: {
        replyEffectStatus: "pending",
        replyText: "Checking the result.",
      },
    },
    {
      messageText: "What is 7 plus 8?",
      fields: { replyEffectStatus: "applied" },
    },
  ])(
    "retains explicit or pending tool work: $messageText $fields",
    ({ messageText, fields }) => {
      const result = messageHandlerFromFieldResult(
        { ...answered, ...fields },
        undefined,
        { actions: available, messageText },
      );
      expect(result.plan.requiresTool).toBe(true);
      expect(result.plan.candidateActions).toContain("CALCULATE");
    },
  );
});

describe("acknowledgment filesystem recovery", () => {
  const available = [
    { name: "FILE", contexts: ["files"] },
    {
      name: "TASKS",
      contexts: ["code"],
      tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
    },
  ];
  const messageText =
    'Create two files under /tmp/readback: index.html containing exactly "<html><body>CHECK-3562</body></html>", and metadata.json containing exactly "{\\"verificationCode\\":\\"CHECK-3562\\",\\"ready\\":true}". Read both saved files to verify their contents, then report the verification code.';
  const intents = [
    "Create index.html at /tmp/readback with exactly <html><body>CHECK-3562</body></html>",
    'Create metadata.json at /tmp/readback with exactly {"verificationCode":"CHECK-3562","ready":true}',
    "Read both saved files to verify their contents",
    "Report the verification code",
  ];
  const envelope = {
    shouldRespond: "RESPOND",
    contexts: [],
    intents,
    replyText: "Working on it.",
    replyEffectStatus: "pending",
    facts: [],
    relationships: [],
    addressedTo: ["user"],
  };

  it("retains all four outcomes but selects only FILE for an unresolved exact write/readback", () => {
    for (const result of [
      messageHandlerFromFieldResult(envelope, undefined, {
        actions: available,
        messageText,
      }),
      parseMessageHandlerModelOutput(JSON.stringify(envelope), {
        actions: available,
        messageText,
      }),
    ]) {
      expect(result?.plan.candidateActions).toEqual(["FILE"]);
      expect(result?.plan.intents).toEqual(intents);
      expect(result?.plan.requiresTool).toBe(true);
    }
  });

  it.each([
    {
      label: "explicit hint",
      fields: { candidateActionNames: ["TASKS"] },
      text: messageText,
      outcomes: intents,
    },
    {
      label: "explicit code domain",
      fields: { contexts: ["code"] },
      text: messageText,
      outcomes: intents,
    },
    {
      label: "explicit delegation",
      fields: {},
      text: `${messageText} Delegate this to a coding agent.`,
      outcomes: [...intents, "Delegate the work to a coding agent"],
    },
    {
      label: "source implementation repair",
      fields: {},
      text: "Edit /tmp/app.ts to fix the runtime bug and add the missing feature.",
      outcomes: [
        "Edit /tmp/app.ts to fix the runtime bug and add the missing feature",
      ],
    },
    {
      label: "source refactor",
      fields: {},
      text: "Refactor the source file /tmp/main.ts to remove duplicated code.",
      outcomes: [
        "Refactor the source file /tmp/main.ts to remove duplicated code",
      ],
    },
    {
      label: "mixed file creation and source refactor",
      fields: {},
      text: 'Create /tmp/a.txt containing exactly "x". Then refactor the file /tmp/main.ts.',
      outcomes: [
        'Create /tmp/a.txt containing exactly "x"',
        "Refactor the file /tmp/main.ts",
      ],
    },
    {
      label: "mixed application work",
      fields: {},
      text: `${messageText} Then build an app that displays those files.`,
      outcomes: [...intents, "Build an app that displays the files"],
    },
  ])("preserves coding ownership for $label", ({ fields, text, outcomes }) => {
    const result = messageHandlerFromFieldResult(
      { ...envelope, ...fields, intents: outcomes },
      undefined,
      { actions: available, messageText: text },
    );
    expect(result?.plan.candidateActions).toContain("TASKS");
    expect(result?.plan.intents).toEqual(outcomes);
  });
});

describe("explicit filesystem routing", () => {
  const available = [{ name: "FILE" }];
  const omitted = {
    shouldRespond: "RESPOND",
    contexts: ["simple"],
    intents: [],
    replyText:
      "Got it, I've got your exact text and target path saved in the workspace. I can help you set that up.",
    replyEffectStatus: "none",
    facts: [],
    relationships: [],
    addressedTo: [],
  };
  it.each([
    "Save the following text exactly, including its final newline, to /tmp/note.txt, then read the file and report its verification code:\nCHECK-3151\nSecond line: blue\nThird line: ready\n",
    "Please read /tmp/input.json and report its contents.",
    "Could you write the supplied text to ./note.txt?",
  ])(
    "plans a concrete filesystem request despite an omitted model intent: %s",
    (messageText) => {
      for (const result of [
        messageHandlerFromFieldResult(omitted, undefined, {
          actions: available,
          messageText,
        }),
        parseMessageHandlerModelOutput(JSON.stringify(omitted), {
          actions: available,
          messageText,
        }),
      ]) {
        expect(result?.plan.candidateActions).toContain("FILE");
        expect(result?.plan.requiresTool).toBe(true);
        expect(
          routeMessageHandlerOutput(
            result ??
              (() => {
                throw new Error("Missing response");
              })(),
          ),
        ).not.toMatchObject({
          type: "final_reply",
        });
      }
    },
  );
  it.each([
    "Explain how to save text to /tmp/note.txt.",
    'What does "Save text to /tmp/note.txt" mean?',
    "If I asked you to read /tmp/note.txt, what would happen?",
    "Read /tmp/note.txt hypothetically; do not execute anything.",
    "Save this to /tmp/note.txt. Do not use tools.",
    "Save this to /tmp/note.txt. No tools, just discuss it.",
    "Save this to /tmp/note.txt without executing any actions.",
    "Do not save anything to /tmp/note.txt.",
    "Here are the contents of /tmp/note.txt: blue. What color is it?",
    "Say exactly: Read /tmp/note.txt",
    "Here is a quoted example; Save text to /tmp/note.txt",
  ])(
    "keeps supplied answers and nonexecution requests simple: %s",
    (messageText) => {
      const result = messageHandlerFromFieldResult(
        { ...omitted, replyText: "Blue." },
        undefined,
        { actions: available, messageText },
      );
      expect(result?.plan.candidateActions ?? []).toEqual([]);
      expect(
        routeMessageHandlerOutput(
          result ??
            (() => {
              throw new Error("Missing response");
            })(),
        ),
      ).toMatchObject({
        type: "final_reply",
        reply: "Blue.",
      });
    },
  );
  it("does not invent an unavailable filesystem operation", () => {
    expect(
      inferDirectCurrentRequestCandidateInference(
        [],
        "Save text to /tmp/note.txt.",
      ).names,
    ).toEqual([]);
  });
});
