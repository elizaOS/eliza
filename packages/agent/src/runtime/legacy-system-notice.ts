/** Projects historical runtime-owned diagnostics without modifying their retained evidence. */
import { type SystemNotice, systemNoticeText } from "@elizaos/core";

/** The caller must first establish that this is an escalation owned by the host. */
export function projectLegacySystemNotice(
  text: string,
  agentName: string | undefined,
):
  | {
      text: string;
      systemNotice?: SystemNotice;
      escalationNotice?: SystemNotice;
      ordinaryText?: string;
    }
  | undefined {
  let changed = false;
  const notices = new Set<SystemNotice>();
  const ordinary: string[] = [];
  const projected = text.split(/\\n---\\n|\n---\n/).map((part) => {
    if (!part.startsWith('Repeated runtime failure "')) {
      ordinary.push(part);
      return part;
    }
    changed = true;
    const notice: SystemNotice = [
      "No local text model is assigned or loaded.",
      "This agent has no model provider configured",
      "No provider registered",
    ].some((message) => part.includes(message))
      ? "model-unavailable"
      : "runtime-error";
    notices.add(notice);
    return systemNoticeText(notice, agentName);
  });
  if (!changed) return undefined;
  const escalationNotice: SystemNotice =
    notices.size > 1
      ? "model-and-runtime-error"
      : notices.has("model-unavailable")
        ? "model-unavailable"
        : "runtime-error";
  const systemNotice = ordinary.length === 0 ? escalationNotice : undefined;
  return {
    text: projected.join("\n---\n"),
    ...(systemNotice ? { systemNotice } : {}),
    escalationNotice,
    ...(ordinary.length ? { ordinaryText: ordinary.join("\n---\n") } : {}),
  };
}

/** Exact deterministic scheduled-brief shape; ordinary or model-authored prose is not matched loosely. */
export function isLegacyUnavailableCheckin(text: string): boolean {
  return (
    /^(Morning|Night) check-in: \d+ overdue todos?, \d+ meetings? today, \d+ (yesterday's wins|wins today), and \d+ tracked habits?\. /.test(
      text,
    ) &&
    [
      "X DMs: unavailable",
      "X timeline: unavailable",
      "X mentions: unavailable",
      "Inbox: unavailable",
      "Gmail: unavailable",
    ].filter((section) => text.includes(section)).length >= 2
  );
}
