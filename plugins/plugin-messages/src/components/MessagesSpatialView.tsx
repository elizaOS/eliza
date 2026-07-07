/**
 * MessagesSpatialView - the SMS messaging surface authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - the spatial primitives still render to terminal lines via
 *                `@elizaos/ui/spatial/tui`, but the plugin no longer ships a
 *                terminal registration (GUI-only view inventory).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the native SMS summary, so it is safe to render in the Node agent process
 * where the terminal lives (no Capacitor runtime import).
 */

import type { SmsMessageSummary } from "@elizaos/capacitor-messages";
import {
  Button,
  Card,
  Divider,
  Field,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

const SENT_SMS_TYPE = 2;

/** A grouped SMS conversation, sorted with its newest message last. */
export interface MessagesThreadSummary {
  id: string;
  address: string;
  messages: SmsMessageSummary[];
  lastMessage: SmsMessageSummary;
  unreadCount: number;
}

export interface MessagesSnapshot {
  threads: MessagesThreadSummary[];
  selectedThreadId: string | null;
  composeAddress: string;
  composeBody: string;
  /** This device holds the Android default-SMS role (full inbox). */
  ownsSmsRole: boolean;
  /** When not held, the package name of whichever app holds the role. */
  smsRoleHolder: string | null;
  loading?: boolean;
  error?: string | null;
}

/** in/out marker for a single message, by Android SMS type discriminant. */
function messageDirection(type: number): "in" | "out" {
  return type === SENT_SMS_TYPE ? "out" : "in";
}

function directionMark(type: number): string {
  return messageDirection(type) === "out" ? ">" : "<";
}

function directionTone(type: number): SpatialTone {
  return messageDirection(type) === "out" ? "primary" : "default";
}

/** Short, display-only timestamp: clock time today, else "Mon D". */
function formatMessageTime(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Sum of unread inbound messages across every thread. */
function totalUnread(threads: MessagesThreadSummary[]): number {
  return threads.reduce((sum, thread) => sum + thread.unreadCount, 0);
}

function roleLabel(snapshot: MessagesSnapshot): string {
  if (snapshot.ownsSmsRole) return "sms-default";
  if (snapshot.smsRoleHolder) return `bridge:${snapshot.smsRoleHolder}`;
  return "bridge-only";
}

function roleTone(snapshot: MessagesSnapshot): SpatialTone {
  return snapshot.ownsSmsRole ? "success" : "warning";
}

export interface MessagesSpatialViewProps {
  snapshot: MessagesSnapshot;
  /**
   * Dispatched action ids: `open-thread:<id>` (open a conversation), `send`,
   * `request-sms-role`, `refresh`, `compose-address:<value>`,
   * `compose-body:<value>`.
   */
  onAction?: (action: string) => void;
}

export function MessagesSpatialView({
  snapshot,
  onAction,
}: MessagesSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const selectedThread =
    snapshot.threads.find((t) => t.id === snapshot.selectedThreadId) ?? null;
  const unread = totalUnread(snapshot.threads);
  const canSend =
    snapshot.composeAddress.trim().length > 0 &&
    snapshot.composeBody.trim().length > 0;

  return (
    <Card gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone={roleTone(snapshot)} grow={1}>
          {roleLabel(snapshot)}
        </Text>
        {unread > 0 ? (
          <Text style="caption" tone="primary">
            {`${unread} unread`}
          </Text>
        ) : null}
        <Text style="caption" tone="muted">
          {snapshot.loading ? "loading" : `${snapshot.threads.length} threads`}
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      {!snapshot.ownsSmsRole ? (
        <Button
          variant="outline"
          tone="warning"
          agent="request-sms-role"
          onPress={dispatch("request-sms-role")}
        >
          Set default SMS
        </Button>
      ) : null}

      <Divider label="threads" />
      {snapshot.threads.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          None
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.threads.slice(0, 8).map((thread) => {
            const selected = thread.id === snapshot.selectedThreadId;
            return (
              <HStack key={thread.id} gap={1} align="center">
                <Text tone={directionTone(thread.lastMessage.type)}>
                  {directionMark(thread.lastMessage.type)}
                </Text>
                <VStack gap={0} grow={1}>
                  <Text bold wrap={false}>
                    {thread.address || "Unknown"}
                  </Text>
                  <Text style="caption" tone="muted" wrap={false}>
                    {thread.lastMessage.body}
                  </Text>
                </VStack>
                <Text style="caption" tone="muted" wrap={false}>
                  {formatMessageTime(thread.lastMessage.date)}
                </Text>
                {thread.unreadCount > 0 ? (
                  <Text style="caption" tone="primary">
                    {String(thread.unreadCount)}
                  </Text>
                ) : null}
                <Button
                  variant={selected ? "solid" : "ghost"}
                  tone="primary"
                  agent={`open-thread-${thread.id}`}
                  onPress={dispatch(`open-thread:${thread.id}`)}
                >
                  Open
                </Button>
              </HStack>
            );
          })}
        </List>
      )}

      <Divider label={selectedThread ? selectedThread.address : "compose"} />
      {selectedThread ? (
        <List gap={0}>
          {selectedThread.messages.slice(-6).map((message) => (
            <HStack key={message.id} gap={1} align="start">
              <Text tone={directionTone(message.type)} style="caption">
                {messageDirection(message.type)}
              </Text>
              <Text grow={1}>{message.body}</Text>
              <Text style="caption" tone="muted" wrap={false}>
                {formatMessageTime(message.date)}
              </Text>
            </HStack>
          ))}
        </List>
      ) : null}

      <Field
        label="To"
        value={snapshot.composeAddress}
        placeholder="phone number"
        agent="compose-address"
        onChange={(value) => onAction?.(`compose-address:${value}`)}
      />
      <Field
        label="Body"
        kind="textarea"
        value={snapshot.composeBody}
        placeholder="message"
        agent="compose-body"
        onChange={(value) => onAction?.(`compose-body:${value}`)}
      />
      <HStack gap={1} wrap>
        <Button
          grow={1}
          disabled={!canSend}
          agent="send"
          onPress={dispatch("send")}
        >
          Send
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
      </HStack>
    </Card>
  );
}
