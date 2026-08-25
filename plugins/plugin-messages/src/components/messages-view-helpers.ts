/**
 * Pure SMS data helpers shared between MessagesView.tsx and
 * messages-interact.ts. Capacitor-aware but React-free so both paths can import
 * it.
 */

import type { SmsMessageSummary } from "@elizaos/capacitor-messages";
import { Messages } from "@elizaos/capacitor-messages";
import {
  type AndroidRoleStatus,
  System,
  type SystemStatus,
} from "@elizaos/capacitor-system";

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
      const sorted = [...threadMessages].sort((a, b) => {
        const aDate =
          typeof a.date === "number" && Number.isFinite(a.date) ? a.date : 0;
        const bDate =
          typeof b.date === "number" && Number.isFinite(b.date) ? b.date : 0;
        return aDate - bDate || a.id.localeCompare(b.id);
      });
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
    .sort((a, b) => {
      const bDate =
        typeof b.lastMessage.date === "number" &&
        Number.isFinite(b.lastMessage.date)
          ? b.lastMessage.date
          : 0;
      const aDate =
        typeof a.lastMessage.date === "number" &&
        Number.isFinite(a.lastMessage.date)
          ? a.lastMessage.date
          : 0;
      return bDate - aDate || a.id.localeCompare(b.id);
    });
}

export function smsRole(status: SystemStatus | null) {
  return (
    status?.roles.find((role: AndroidRoleStatus) => role.role === "sms") ?? null
  );
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
