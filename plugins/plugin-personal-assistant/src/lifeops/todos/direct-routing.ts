/**
 * Declares the deterministic boundary for an explicitly undated owner Todo.
 * The canonical undated-intent policy decides schedule semantics; this module
 * only establishes that the current message asks to create or preview a Todo.
 * Core still enforces role, capability, connector, and action validation gates.
 */

import type { DirectActionRoutingRule } from "@elizaos/core";
import { textStatesExplicitUndatedTodo } from "../../actions/lib/undated-todo-intent.js";

const TODO_NOUN_PATTERNS: readonly RegExp[] = [
  /\b(?:todo|to-do|task|checklist item)\b/iu,
  /\b(?:tarea|pendiente)\b/iu,
  /\b(?:tarefa|afazer)\b/iu,
  /(?:待办事项|待辦事項|任务|任務)/u,
  /(?:タスク|やること)/u,
  /(?:할 일|작업)/u,
  /\b(?:việc cần làm|nhiệm vụ)\b/iu,
  /\b(?:gawain|dapat gawin)\b/iu,
];

const TODO_WRITE_OR_PREVIEW_PATTERNS: readonly RegExp[] = [
  /\b(?:add|create|make|save|draft|preview|set up)\b/iu,
  /\b(?:añad(?:e|ir)|agreg(?:a|ar)|cre(?:a|ar)|guard(?:a|ar)|vista previa)\b/iu,
  /\b(?:adicion(?:a|ar)|cri(?:a|ar)|salv(?:a|ar)|prévia|visualizar)\b/iu,
  /(?:添加|新增|创建|建立|预览|預覽|保存|儲存)/u,
  /(?:追加|作成|作って|プレビュー|保存)/u,
  /(?:추가|만들|생성|미리 보기|저장)/u,
  /\b(?:thêm|tạo|xem trước|lưu)\b/iu,
  /\b(?:idagdag|gumawa|likhain|i-preview|i-save)\b/iu,
];

export function looksLikeExplicitUndatedOwnerTodoRequest(
  text: string,
): boolean {
  const normalized = text.trim();
  return (
    normalized.length > 0 &&
    TODO_NOUN_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    TODO_WRITE_OR_PREVIEW_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    ) &&
    textStatesExplicitUndatedTodo(normalized)
  );
}

export function createUndatedOwnerTodoDirectRoutingRule(): DirectActionRoutingRule {
  return {
    id: "lifeops.owner-todo-undated-create",
    actionNames: ["OWNER_TODOS"],
    requiredActionTags: [
      "domain:reminders",
      "capability:write",
      "effect:receipt-required",
    ],
    contexts: ["tasks", "todos", "productivity"],
    matches: looksLikeExplicitUndatedOwnerTodoRequest,
  };
}
