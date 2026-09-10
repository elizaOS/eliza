/**
 * Deterministic multilingual coverage for the owner-authority policy that
 * permits unscheduled Todo writes and supplies the matching extraction prompt.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { extractLifeOperationWithLlm } from "./extract-life-operation.js";
import { extractTaskCreatePlanWithLlm } from "./extract-task-plan.js";
import {
  resolveUndatedTodoAuthority,
  textContradictsExplicitUndatedTodo,
  textStatesExplicitUndatedTodo,
  UNDATED_TODO_EXTRACTION_GUIDANCE,
} from "./undated-todo-intent.js";

const EXPLICIT_UNDATED_REQUESTS = [
  ["English no-date", "add buy milk with no due date"],
  ["English undated", "add buy milk as an undated task"],
  ["English someday", "add buy milk someday"],
  ["Spanish", "añade comprar leche sin fecha"],
  ["Portuguese", "adicionar comprar leite sem prazo"],
  ["Chinese", "添加买牛奶，没有截止日期"],
  ["Japanese", "牛乳を買う、期限なし"],
  ["Korean", "우유 사기, 마감일 없이"],
  ["Vietnamese", "thêm việc mua sữa không có ngày đến hạn"],
  ["Tagalog", "idagdag ang bumili ng gatas, walang takdang petsa"],
] as const;

const CONTRADICTORY_REQUESTS = [
  ["English weekday", "add buy milk with no due date, but Friday"],
  ["English bare weekday", "add buy milk with no due date Friday"],
  ["English next weekday", "add buy milk someday next Friday"],
  ["Spanish weekday", "añade comprar leche sin fecha, pero el lunes"],
  ["Spanish bare weekday", "añade comprar leche sin fecha el lunes"],
  [
    "Portuguese weekday",
    "adicionar comprar leite sem prazo, mas na segunda-feira",
  ],
  [
    "Portuguese bare weekday",
    "adicionar comprar leite sem prazo na segunda-feira",
  ],
  ["Portuguese tomorrow", "adicionar comprar leite sem prazo, mas amanhã"],
  ["Chinese weekday", "添加买牛奶，没有截止日期，但周一"],
  ["Chinese bare weekday", "添加买牛奶，没有截止日期周一"],
  ["Japanese weekday", "牛乳を買う、期限なし、でも月曜日"],
  ["Japanese bare weekday", "牛乳を買う、期限なし月曜日"],
  ["Korean weekday", "우유 사기, 마감일 없이, 하지만 월요일"],
  ["Korean bare weekday", "우유 사기, 마감일 없이 월요일"],
  [
    "Vietnamese weekday",
    "thêm việc mua sữa không có ngày đến hạn, nhưng thứ hai",
  ],
  [
    "Vietnamese bare weekday",
    "thêm việc mua sữa không có ngày đến hạn thứ hai",
  ],
  [
    "Tagalog weekday",
    "idagdag ang bumili ng gatas, walang takdang petsa, pero sa Lunes",
  ],
  [
    "Tagalog bare weekday",
    "idagdag ang bumili ng gatas, walang takdang petsa sa Lunes",
  ],
  ["relative date", "add buy milk someday in two weeks"],
  ["recurrence", "add buy milk with no due date, every Monday"],
] as const;

const NEGATED_REQUESTS = [
  ["English ASCII apostrophe", "don't leave buy milk with no due date"],
  ["English curly apostrophe", "don’t leave buy milk with no due date"],
  [
    "English long clause",
    "do not make the older imported backlog item with its long explanatory metadata and all of its historical labels and archival notes and inherited context a plain todo",
  ],
  ["Spanish", "no dejes comprar leche sin fecha"],
  ["Portuguese", "não deixe comprar leite sem prazo"],
  ["Chinese", "不要把买牛奶设成没有截止日期"],
  ["Japanese", "期限なしにはしないで"],
  ["Korean", "마감일 없이 만들지 마"],
  ["Vietnamese", "đừng để việc mua sữa không có ngày đến hạn"],
  ["Tagalog", "huwag gawing walang takdang petsa ang pagbili ng gatas"],
] as const;

describe("textStatesExplicitUndatedTodo", () => {
  it("recognizes the live F32 residual composite and its parts (deadline/general forms)", () => {
    for (const text of [
      "no deadline, it's just a general todo",
      "no deadline",
      "without a deadline",
      "just a general todo",
      "it's a simple task",
      "make it a regular todo",
    ]) {
      expect(textStatesExplicitUndatedTodo(text)).toBe(true);
    }
    // Negations and schedules still win over the new phrases.
    expect(textStatesExplicitUndatedTodo("not a general todo")).toBe(false);
    expect(
      textStatesExplicitUndatedTodo("no deadline, actually make it friday"),
    ).toBe(false);
  });

  it.each(EXPLICIT_UNDATED_REQUESTS)(
    "accepts explicit undated authority in %s",
    (_caseName, text) => {
      expect(textStatesExplicitUndatedTodo(text)).toBe(true);
    },
  );

  it.each(CONTRADICTORY_REQUESTS)(
    "rejects a schedule contradiction in %s",
    (_caseName, text) => {
      expect(textStatesExplicitUndatedTodo(text)).toBe(false);
      expect(textContradictsExplicitUndatedTodo(text)).toBe(true);
    },
  );

  it.each(NEGATED_REQUESTS)(
    "rejects negated undated wording in %s",
    (_caseName, text) => {
      expect(textStatesExplicitUndatedTodo(text)).toBe(false);
      expect(textContradictsExplicitUndatedTodo(text)).toBe(false);
    },
  );

  it.each([
    "add buy milk as a todo",
    "add buy milk tomorrow as a todo",
    "whenever, end of the month",
  ])("rejects omitted no-date authority in %p", (text) => {
    expect(textStatesExplicitUndatedTodo(text)).toBe(false);
  });

  it.each([
    "add tomorrow's agenda with no due date",
    "add Tomorrow, and Tomorrow, and Tomorrow to my reading list with no due date",
    "add Weekly Review with no due date",
    "add Daily Stoic reading with no due date",
  ])("does not treat a temporal title noun as a schedule in %p", (text) => {
    expect(textStatesExplicitUndatedTodo(text)).toBe(true);
  });

  it.each([
    "Friday; actually add buy milk with no due date",
    "add buy milk with no due date, but Friday; actually no due date",
    "add buy milk tomorrow at 9; actually make it no due date",
    "don't make the old item a plain todo. Add buy milk with no due date.",
    "add buy milk with no due date; not Friday",
    "add buy milk with no due date; call it Friday",
    "add buy milk with no due date; call it “Friday”",
    "add a todo with no due date; call it Weekly Review",
  ])("honors the last authoritative directive in %p", (text) => {
    expect(textStatesExplicitUndatedTodo(text)).toBe(true);
  });

  it("lets a final negated no-date directive revoke an earlier allowance", () => {
    expect(
      textStatesExplicitUndatedTodo(
        "Add buy milk with no due date; actually don't leave it with no due date.",
      ),
    ).toBe(false);
  });
});

describe("undated Todo extraction guidance", () => {
  it("reaches the task planner primary and repair prompts", async () => {
    const prompts: string[] = [];
    const runtime = {
      useModel: vi.fn(async (_modelType: unknown, args: { prompt: string }) => {
        prompts.push(args.prompt);
        return prompts.length === 1
          ? "invalid"
          : JSON.stringify({
              cadenceKind: "unscheduled",
              mode: "create",
              requestKind: "todo",
              response: null,
              title: "Buy milk",
            });
      }),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;

    const result = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "add buy milk with no due date",
      state: undefined,
      now: new Date("2026-07-01T18:00:00Z"),
      timeZone: "America/Denver",
    });

    expect(result).toMatchObject({
      cadenceKind: "unscheduled",
      mode: "create",
      title: "Buy milk",
    });
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain(UNDATED_TODO_EXTRACTION_GUIDANCE);
      expect(prompt.match(/"unscheduled" — ONLY/g)).toHaveLength(1);
      expect(prompt).toContain("English: no due date / someday");
      expect(prompt).toContain("Tagalog: walang takdang petsa");
    }
  });

  it("reaches the operation classifier primary, repair, and recovery prompts", async () => {
    const prompts: string[] = [];
    const runtime = {
      useModel: vi.fn(async (_modelType: unknown, args: { prompt: string }) => {
        prompts.push(args.prompt);
        return args.prompt.startsWith("Recover the core LifeOps intent")
          ? JSON.stringify({
              operation: "create",
              confidence: 1,
              shouldAct: true,
              missing: [],
            })
          : "invalid";
      }),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const message = {
      content: { text: "add buy milk with no due date" },
    } as Memory;

    const result = await extractLifeOperationWithLlm({
      runtime,
      message,
      state: undefined,
      intent: "add buy milk with no due date",
    });

    expect(result).toMatchObject({ operation: "create", shouldAct: true });
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain(UNDATED_TODO_EXTRACTION_GUIDANCE);
    }
  });
});

describe("named Todo authority inside authored workflows", () => {
  const title = "Copper meadow review";
  const selected = `Create a todo titled "${title}" with no due date or schedule.`;
  it("accepts the exact recorded eight-step owner request", () => {
    const text =
      "Complete this workflow in my local Eliza calendar and todos, in this order, using IDs returned by the earlier operations. This is one authorization for all eight steps; do not ask me to continue between steps.\n1. Read my local calendar for September 10, 2026 in America/New_York.\n2. Create an undated todo titled 'P19 copper meadow dependency review', with no due date or schedule.\n3. Create a local calendar event with that title on September 10, 2026 from 11:00 to 11:30 AM America/New_York. Put the returned todo ID in the event description.\n4. Read the same calendar date again to verify that the event exists.\n5. Update the event using its returned event ID so it ends at 11:45 AM instead.\n6. Mark the todo complete using its returned todo ID.\n7. Read the todo back, including completed items, to verify its status.\n8. Read the same calendar date again to verify the final event times and description.\nGive the final todo and event IDs and verified state. If any operation fails, accurately identify completed work and the remaining failure. Use local records only; do not connect external calendars or messaging services.";
    expect(
      resolveUndatedTodoAuthority(text, "P19 copper meadow dependency review"),
    ).toEqual({ explicit: true, contradicts: false, operationScoped: true });
  });
  it("keeps a separate calendar operation from scheduling the explicitly undated Todo", () => {
    const text = `Complete all steps in order.\n1. Read the calendar tomorrow.\n2. ${selected}\n3. Create a calendar event tomorrow at 11:00. Put the returned todo ID in its description.\n4. Update the event to end at 11:45 instead.\n5. Mark the todo complete.`;
    expect(textStatesExplicitUndatedTodo(text)).toBe(false);
    expect(resolveUndatedTodoAuthority(text, title)).toEqual({
      explicit: true,
      contradicts: false,
      operationScoped: true,
    });
  });
  it.each([
    "Actually schedule it tomorrow at 9.",
    `Actually schedule ${title} tomorrow at 9.`,
    "Schedule the todo on Friday.",
    "Do not leave the todo with no due date.",
  ])(
    "preserves a later correction even after an independent calendar sentence: %s",
    (correction) => {
      const text = `1. ${selected}\n2. Create a calendar event tomorrow at 11:00. ${correction}`;
      expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(false);
    },
  );
  it("keeps an anaphoric correction in a clause mentioning a calendar", () => {
    const text = `1. ${selected}\n2. Create a calendar event tomorrow, but actually schedule it on Friday.`;
    expect(resolveUndatedTodoAuthority(text, title).contradicts).toBe(true);
  });
  it("does not borrow another named Todo's no-date authority", () => {
    const text = `1. Create a todo titled "Copper meadow review".\n2. Create a todo titled "Book the taxi" with no due date.`;
    expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(false);
    expect(resolveUndatedTodoAuthority(text, "Book the taxi").explicit).toBe(
      true,
    );
  });
  it("does not borrow a separate Todo's following sentence", () => {
    const text = `1. Create a todo titled "Copper meadow review".\n2. Create a todo titled "Book the taxi". Then make it no due date.`;
    expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(false);
    expect(resolveUndatedTodoAuthority(text, "Book the taxi").explicit).toBe(
      true,
    );
  });
  it("retains scheduling assigned to the selected title in a calendar clause", () => {
    const text = `1. ${selected}\n2. Update the calendar and schedule Copper meadow review tomorrow.`;
    expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(false);
  });
  it.each(["first", "previous", "earlier", "original", "other"])(
    "preserves a %s Todo cross-reference inside another creation block",
    (reference) => {
      const text = `1. ${selected}\n2. Create a todo titled "Book the taxi". Also schedule the ${reference} todo tomorrow.`;
      expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(false);
    },
  );
  it("retains an ordinal item reference in another Todo block", () => {
    const text = `1. ${selected}\n2. Create a todo titled "Book the taxi". Also schedule the first one tomorrow.`;
    expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(false);
  });
  it("rejects authored scope when a block creates multiple named Todos", () => {
    const text = `1. Create a todo titled "Copper meadow review". Create a todo titled "Book the taxi" with no due date.\n2. Read calendar tomorrow.`;
    const result = resolveUndatedTodoAuthority(text, title);
    expect(result.operationScoped).toBe(false);
    expect(result.explicit).toBe(textStatesExplicitUndatedTodo(text));
    expect(result.explicit).toBe(false);
  });
  it("keeps different named Todos' timing independent", () => {
    const text = `1. ${selected}\n2. Create a todo titled "Book the taxi" tomorrow at 9.`;
    expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(true);
    expect(resolveUndatedTodoAuthority(text, "Book the taxi").explicit).toBe(
      false,
    );
  });
  it("honors a final explicit no-date correction for the selected Todo", () => {
    const text = `1. ${selected}\n2. Actually schedule it tomorrow.\n3. Actually make it no due date.`;
    expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(true);
  });
  it.each([
    `1. ${selected}\n2. ${selected}\n3. Create a calendar event tomorrow.`,
    `${selected} Create a calendar event tomorrow.`,
    `1. Create a todo titled "Different title" with no due date.\n2. Create a calendar event tomorrow.`,
  ])(
    "retains whole-message policy when source identity is ambiguous or missing",
    (text) => {
      const result = resolveUndatedTodoAuthority(text, title);
      expect(result.operationScoped).toBe(false);
      expect(result.explicit).toBe(textStatesExplicitUndatedTodo(text));
      expect(result.contradicts).toBe(textContradictsExplicitUndatedTodo(text));
    },
  );
  it("does not accept a selected negated no-date directive", () => {
    const text = `1. Do not create a todo titled "${title}" with no due date.\n2. Create a calendar event tomorrow.`;
    expect(resolveUndatedTodoAuthority(text, title).explicit).toBe(false);
  });
});
