/**
 * Covers the plugin-owned routing boundary that makes an undated Todo preview
 * execute the real owner action instead of trusting model-authored preview text.
 */

import { describe, expect, it } from "vitest";
import {
  createUndatedOwnerTodoDirectRoutingRule,
  looksLikeExplicitUndatedOwnerTodoRequest,
} from "./direct-routing";

describe("undated owner Todo direct routing", () => {
  it.each([
    "Create a personal todo titled Buy oat milk. It has no due date or reminder. Preview it first and do not save until I confirm.",
    "Add a task called Renew passport someday and preview it first.",
    "Crea una tarea llamada Comprar leche sin fecha y muéstrame una vista previa.",
    "Crie uma tarefa chamada Comprar leite sem prazo e mostre uma prévia.",
    "创建一个叫买牛奶的待办事项，没有截止日期，先预览。",
    "牛乳を買うというタスクを期限なしで作成し、先にプレビューして。",
    "우유 사기라는 할 일을 마감일 없이 만들고 먼저 미리 보기 해줘.",
    "Tạo việc cần làm tên Mua sữa không có ngày đến hạn và xem trước.",
    "Gumawa ng gawain na Bumili ng gatas na walang takdang petsa at i-preview muna.",
  ])("routes an explicit undated Todo write or preview: %s", (text) => {
    expect(looksLikeExplicitUndatedOwnerTodoRequest(text)).toBe(true);
  });

  it.each([
    "Explain what an undated todo is.",
    "Create a calendar event with no due date.",
    "Don't create a todo with no due date.",
    "Create a todo with no due date, but schedule it Friday.",
    "What todos do I have?",
    "Alice created a task without a due date.",
  ])(
    "does not claim adjacent, negated, scheduled, or read-only intent: %s",
    (text) => {
      expect(looksLikeExplicitUndatedOwnerTodoRequest(text)).toBe(false);
    },
  );

  it("targets the owner Todo action behind structural execution gates", () => {
    expect(createUndatedOwnerTodoDirectRoutingRule()).toMatchObject({
      id: "lifeops.owner-todo-undated-create",
      actionNames: ["OWNER_TODOS"],
      requiredActionTags: expect.arrayContaining([
        "domain:reminders",
        "capability:write",
        "effect:receipt-required",
      ]),
      contexts: ["tasks", "todos", "productivity"],
    });
  });
});
