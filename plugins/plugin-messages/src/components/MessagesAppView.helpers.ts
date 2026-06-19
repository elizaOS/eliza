// Pure SMS data helpers shared between MessagesAppView.tsx (the React views) and
// MessagesAppView.interact.ts (the terminal capability handler). Split out so the
// .tsx file exports only React components and stays Fast-Refresh-compatible
// (Vite full-reloads a component file that also exports plain functions/types).

import type { SmsMessageSummary } from "@elizaos/capacitor-messages";
import { Messages } from "@elizaos/capacitor-messages";
import { System, type SystemStatus } from "@elizaos/capacitor-system";

export type ThreadSummary = {
  id: string;
  address: string;
  messages: SmsMessageSummary[];
  lastMessage: SmsMessageSummary;
  unreadCount: number;
};

const INBOUND_SMS_TYPE = 1;

export function buildThreads(messages: SmsMessageSummary[]): ThreadSummary[] {
  const byThread = new Map<string, SmsMessageSummary[]>();
  for (const message of messages) {
    const key = message.threadId || message.address || message.id;
    const list = byThread.get(key) ?? [];
    list.push(message);
    byThread.set(key, list);
  }
  return Array.from(byThread.entries())
    .map(([id, threadMessages]) => {
      const sorted = [...threadMessages].sort((a, b) => a.date - b.date);
      const lastMessage = sorted[sorted.length - 1] ?? threadMessages[0];
      return {
        id,
        address: lastMessage?.address,
        messages: sorted,
        lastMessage,
        unreadCount: sorted.filter(
          (m) => !m.read && m.type === INBOUND_SMS_TYPE,
        ).length,
      };
    })
    .filter((thread): thread is ThreadSummary => Boolean(thread.lastMessage))
    .sort((a, b) => b.lastMessage.date - a.lastMessage.date);
}

export function smsRole(status: SystemStatus | null) {
  return status?.roles.find((role) => role.role === "sms") ?? null;
}

export function normalizeMessagesLimit(value: unknown, fallback = 200): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(1, Math.trunc(value)));
}

export async function loadMessagesState(limit = 200) {
  const [messageResult, statusResult] = await Promise.all([
    Messages.listMessages({ limit: normalizeMessagesLimit(limit) }),
    System.getStatus().catch(() => null),
  ]);
  const threads = buildThreads(messageResult.messages);
  const currentSmsRole = smsRole(statusResult);
  return {
    messages: messageResult.messages,
    threads,
    systemStatus: statusResult,
    ownsSmsRole: currentSmsRole?.held === true,
    smsRoleHolder: currentSmsRole?.holders[0] ?? null,
  };
}
