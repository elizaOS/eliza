/** Projects historical runtime-owned diagnostics without modifying their retained evidence. */
import { type SystemNotice, systemNoticeText } from "@elizaos/core";

/** The caller must first establish that this is an escalation owned by the host. */
export function projectLegacySystemNotice(text: string):
  | {
      text: string;
      systemNotice?: SystemNotice;
    }
  | undefined {
  let changed = false;
  const notices = new Set<SystemNotice>();
  let ordinary = false;
  const projected = text.split(/\\n---\\n|\n---\n/).map((part) => {
    if (!part.startsWith('Repeated runtime failure "')) {
      ordinary = true;
      return part;
    }
    changed = true;
    const notice: SystemNotice = part.includes(
      "No local text model is assigned or loaded.",
    )
      ? "model-unavailable"
      : "runtime-error";
    notices.add(notice);
    return systemNoticeText(notice);
  });
  if (!changed) return undefined;
  const systemNotice =
    !ordinary && notices.size === 1 ? [...notices][0] : undefined;
  return {
    text: projected.join("\n---\n"),
    ...(systemNotice ? { systemNotice } : {}),
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
