"use client";

import { cn, logger } from "@feed/shared";
import { Bell, MessageCircle, Send, User, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/auth";
import { apiUrl } from "@/utils/api-url";

/**
 * Notification type for admin notifications tab.
 */
type NotificationType =
  | "system"
  | "comment"
  | "reaction"
  | "follow"
  | "mention"
  | "reply"
  | "share";

/**
 * Recipient type for admin notifications tab.
 */
type RecipientType = "specific" | "all";

/**
 * Notifications tab component for sending admin notifications and testing DMs.
 *
 * Provides interface for sending notifications to specific users or all users.
 * Includes DM testing functionality for debugging direct messages. Shows current
 * user ID and debug information.
 *
 * Features:
 * - Send notifications (specific user or all users)
 * - Notification type selection
 * - DM testing
 * - Current user display
 * - Debug information
 * - Loading states
 * - Error handling
 *
 * @returns Notifications tab element
 */
export function NotificationsTab() {
  const [message, setMessage] = useState("");
  const [userId, setUserId] = useState("");
  const [type, setType] = useState<NotificationType>("system");
  const [recipientType, setRecipientType] = useState<RecipientType>("specific");
  const [isSending, startSending] = useTransition();

  // DM Testing state
  const [dmSenderId, setDmSenderId] = useState("demo-user-feed-support");
  const [dmRecipientId, setDmRecipientId] = useState("");
  const [isSendingDm, startSendingDm] = useTransition();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<Record<string, unknown> | null>(
    null,
  );

  // Fetch current user ID on mount
  useEffect(() => {
    const fetchCurrentUser = async () => {
      const token = getAuthToken();
      if (!token) return;

      const response = await fetch(apiUrl("/api/users/me"), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setCurrentUserId(data.user?.id || null);
      }
    };

    fetchCurrentUser();
  }, []);

  const handleSend = useCallback(async () => {
    if (!message.trim()) {
      toast.error("Please enter a message");
      return;
    }

    if (recipientType === "specific" && !userId.trim()) {
      toast.error("Please enter a user ID");
      return;
    }

    startSending(async () => {
      const token = getAuthToken();

      if (!token) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(apiUrl("/api/admin/notifications"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: message.trim(),
          type,
          ...(recipientType === "specific"
            ? { userId: userId.trim() }
            : { sendToAll: true }),
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success(data.message || "Notification sent successfully");
        // Reset form
        setMessage("");
        setUserId("");
      } else {
        toast.error(data.message || "Failed to send notification");
      }
    });
  }, [message, userId, type, recipientType]);

  const handleDebugDMs = useCallback(async () => {
    if (!dmRecipientId.trim()) {
      toast.error("Please enter a recipient user ID to debug");
      return;
    }

    startSendingDm(async () => {
      const token = getAuthToken();

      if (!token) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(
        `/api/admin/debug-dm?userId=${encodeURIComponent(dmRecipientId.trim())}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const data = await response.json();
      logger.debug("Debug DM response", { data }, "NotificationsTab");
      setDebugInfo(data);

      if (data.participantRecords?.length === 0) {
        toast.error(`No DM chats found for user ${dmRecipientId}`);
      } else {
        toast.success(
          `Found ${data.participantRecords?.length || 0} DM participant records and ${data.chats?.length || 0} chats`,
        );
      }
    });
  }, [dmRecipientId]);

  const handleSendTestDMs = useCallback(async () => {
    if (!dmSenderId.trim()) {
      toast.error("Please enter a sender user ID");
      return;
    }

    if (!dmRecipientId.trim()) {
      toast.error("Please enter a recipient user ID");
      return;
    }

    if (dmSenderId === dmRecipientId) {
      toast.error("Sender and recipient must be different users");
      return;
    }

    startSendingDm(async () => {
      const token = getAuthToken();

      if (!token) {
        throw new Error("Not authenticated");
      }

      toast.info("Sending 100 test DM messages... This may take a moment.");

      const response = await fetch(apiUrl("/api/admin/test-dm-messages"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          senderId: dmSenderId.trim(),
          recipientId: dmRecipientId.trim(),
          messageCount: 100,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        const chatId = data.chatId;
        logger.debug(
          "Test DM messages sent",
          { chatId, data },
          "NotificationsTab",
        );
        toast.success(data.message || "Test DM messages sent successfully", {
          duration: 10000,
          action: {
            label: "Go to Chats",
            onClick: () => (window.location.href = "/chats"),
          },
        });
      } else {
        logger.error(
          "Failed to send test DM messages",
          { data },
          "NotificationsTab",
        );
        toast.error(data.message || "Failed to send test DM messages");
      }
    });
  }, [dmSenderId, dmRecipientId]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Bell className="h-5 w-5 text-primary" />
        <h2 className="font-semibold text-xl">Send Notifications</h2>
      </div>

      {/* Form */}
      <div className="space-y-4 rounded-lg border border-border bg-card p-6">
        {/* Recipient Type */}
        <div>
          <label className="mb-2 block font-medium text-sm">Recipient</label>
          <div className="flex gap-2">
            <button
              onClick={() => setRecipientType("specific")}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 transition-colors",
                recipientType === "specific"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background hover:bg-muted",
              )}
            >
              <User className="h-4 w-4" />
              <span>Specific User</span>
            </button>
            <button
              onClick={() => setRecipientType("all")}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 transition-colors",
                recipientType === "all"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background hover:bg-muted",
              )}
            >
              <Users className="h-4 w-4" />
              <span>All Users</span>
            </button>
          </div>
        </div>

        {/* User ID (only for specific user) */}
        {recipientType === "specific" && (
          <div>
            <label htmlFor="userId" className="mb-2 block font-medium text-sm">
              User ID
            </label>
            <input
              id="userId"
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="Enter user ID (e.g., cm123abc...)"
              className={cn(
                "w-full rounded-lg border border-border px-4 py-2",
                "bg-background text-foreground",
                "focus:border-border focus:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
              disabled={isSending}
            />
            <p className="mt-1 text-muted-foreground text-xs">
              You can find user IDs in the Users tab or in the database
            </p>
          </div>
        )}

        {/* Notification Type */}
        <div>
          <label htmlFor="type" className="mb-2 block font-medium text-sm">
            Type
          </label>
          <select
            id="type"
            value={type}
            onChange={(e) => setType(e.target.value as NotificationType)}
            className={cn(
              "w-full rounded-lg border border-border px-4 py-2",
              "bg-background text-foreground",
              "focus:border-border focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={isSending}
          >
            <option value="system">System</option>
            <option value="comment">Comment</option>
            <option value="reaction">Reaction</option>
            <option value="follow">Follow</option>
            <option value="mention">Mention</option>
            <option value="reply">Reply</option>
            <option value="share">Share</option>
          </select>
        </div>

        {/* Message */}
        <div>
          <label htmlFor="message" className="mb-2 block font-medium text-sm">
            Message
          </label>
          <textarea
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter notification message..."
            rows={4}
            maxLength={500}
            className={cn(
              "w-full rounded-lg border border-border px-4 py-2",
              "bg-background text-foreground",
              "focus:border-border focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "resize-none",
            )}
            disabled={isSending}
          />
          <p className="mt-1 text-muted-foreground text-xs">
            {message.length}/500 characters
          </p>
        </div>

        {/* Send Button */}
        <button
          onClick={handleSend}
          disabled={
            isSending ||
            !message.trim() ||
            (recipientType === "specific" && !userId.trim())
          }
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-lg px-6 py-3",
            "bg-primary font-semibold text-primary-foreground",
            "transition-colors hover:bg-primary/90",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <Send className="h-4 w-4" />
          <span>{isSending ? "Sending..." : "Send Notification"}</span>
        </button>
      </div>

      {/* Warning */}
      {recipientType === "all" && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4">
          <p className="text-sm text-yellow-600 dark:text-yellow-400">
            ⚠️ <strong>Warning:</strong> This will send the notification to all
            non-banned users. Make sure your message is appropriate for all
            users.
          </p>
        </div>
      )}

      {/* Info */}
      <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-4">
        <h3 className="font-semibold text-sm">Tips:</h3>
        <ul className="list-inside list-disc space-y-1 text-muted-foreground text-sm">
          <li>Notifications appear in the user&apos;s notification feed</li>
          <li>System notifications are best for announcements and updates</li>
          <li>Keep messages concise and actionable (max 500 characters)</li>
          <li>
            Notifications won&apos;t be sent to banned users or NPCs/actors
          </li>
        </ul>
      </div>

      {/* Divider */}
      <div className="my-8 border-border border-t" />

      {/* Group Invite Section */}
      <GroupInviteSection />

      {/* Divider */}
      <div className="my-8 border-border border-t" />

      {/* DM Testing Section */}
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-xl">Test DM Messages</h2>
        </div>

        <p className="text-muted-foreground text-sm">
          Send 100 test messages between users to test DM pagination and
          scrolling behavior.
        </p>

        {/* Form */}
        <div className="space-y-4 rounded-lg border border-border bg-card p-6">
          {/* Sender User ID */}
          <div>
            <label
              htmlFor="dmSenderId"
              className="mb-2 block font-medium text-sm"
            >
              Sender User ID
            </label>
            <input
              id="dmSenderId"
              type="text"
              value={dmSenderId}
              onChange={(e) => setDmSenderId(e.target.value)}
              placeholder="Enter sender user ID"
              className={cn(
                "w-full rounded-lg border border-border px-4 py-2",
                "bg-background text-foreground",
                "focus:border-border focus:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
              disabled={isSendingDm}
            />
            <p className="mt-1 text-muted-foreground text-xs">
              Default: demo-user-feed-support (Feed Support)
            </p>
          </div>

          {/* Recipient User ID */}
          <div>
            <label
              htmlFor="dmRecipientId"
              className="mb-2 block font-medium text-sm"
            >
              Recipient User ID
            </label>
            <div className="flex gap-2">
              <input
                id="dmRecipientId"
                type="text"
                value={dmRecipientId}
                onChange={(e) => setDmRecipientId(e.target.value)}
                placeholder="Enter recipient user ID or use quick fill"
                className={cn(
                  "flex-1 rounded-lg border border-border px-4 py-2",
                  "bg-background text-foreground",
                  "focus:border-border focus:outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
                disabled={isSendingDm}
              />
              <button
                type="button"
                onClick={() => {
                  if (currentUserId) {
                    setDmRecipientId(currentUserId);
                    toast.success("Using your user ID as recipient");
                  } else {
                    toast.error("Could not fetch your user ID");
                  }
                }}
                disabled={isSendingDm || !currentUserId}
                className={cn(
                  "rounded-lg border border-border px-3 py-2",
                  "bg-primary text-primary-foreground transition-colors hover:bg-primary/90",
                  "whitespace-nowrap font-semibold text-xs",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
                title="Use your logged-in user ID as recipient"
              >
                Use My ID
              </button>
              <button
                type="button"
                onClick={() => setDmRecipientId("demo-user-welcome-bot")}
                disabled={isSendingDm}
                className={cn(
                  "rounded-lg border border-border px-3 py-2",
                  "bg-background transition-colors hover:bg-muted",
                  "whitespace-nowrap text-xs",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
                title="Use Welcome Bot as recipient"
              >
                Welcome Bot
              </button>
            </div>
            <p className="mt-1 text-muted-foreground text-xs">
              Click &quot;Use My ID&quot; to use your logged-in account
              (blockchain_b0ss), or &quot;Welcome Bot&quot; for the test user
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleDebugDMs}
              disabled={!dmRecipientId.trim()}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-3",
                "bg-secondary font-medium text-secondary-foreground",
                "border border-border transition-colors hover:bg-secondary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
              title="Check what DM chats exist for this user"
            >
              🔍 Debug DMs
            </button>

            <button
              onClick={handleSendTestDMs}
              disabled={
                isSendingDm || !dmSenderId.trim() || !dmRecipientId.trim()
              }
              className={cn(
                "flex flex-[2] items-center justify-center gap-2 rounded-lg px-6 py-3",
                "bg-primary font-semibold text-primary-foreground",
                "transition-colors hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <MessageCircle className="h-4 w-4" />
              <span>
                {isSendingDm
                  ? "Sending 100 Messages..."
                  : "Send 100 Test DM Messages"}
              </span>
            </button>
          </div>
        </div>

        {/* Debug Info Display */}
        {debugInfo && (
          <div className="mt-4 rounded-lg border border-border bg-card p-4">
            <h3 className="mb-2 font-semibold text-sm">Debug Results:</h3>
            <div className="max-h-96 overflow-auto rounded bg-muted p-3 font-mono text-xs">
              <pre>{JSON.stringify(debugInfo, null, 2)}</pre>
            </div>
          </div>
        )}

        {/* Info */}
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-4">
          <p className="text-blue-600 text-sm dark:text-blue-400">
            ℹ️ <strong>Note:</strong> This will create or use an existing DM chat
            between the two users and send 100 numbered test messages. Perfect
            for testing pagination when scrolling up in the chat.
          </p>
        </div>

        {/* Default Users Info */}
        <div className="space-y-3 rounded-lg border border-border bg-muted/50 p-4">
          <h3 className="font-semibold text-sm">How to Use:</h3>
          <ol className="list-inside list-decimal space-y-2 text-muted-foreground text-sm">
            <li>
              <strong>Easiest:</strong> Click &quot;Use My ID&quot; button to
              test with your own account!
            </li>
            <li>
              <strong>Or use Welcome Bot:</strong> Click &quot;Welcome Bot&quot;
              to use the default test user
            </li>
            <li>
              <strong>Find other IDs:</strong> Go to the &quot;Users&quot; tab
              above to see all user IDs
            </li>
          </ol>

          <div className="mt-3 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3">
            <p className="text-xs text-yellow-600 dark:text-yellow-400">
              ⚠️ <strong>Important:</strong> You need the{" "}
              <strong>user ID</strong> (long string like
              &quot;cm3x7y8z9...&quot;), not the username. The &quot;Use My
              ID&quot; button handles this automatically!
            </p>
          </div>

          <div className="mt-3 border-border border-t pt-3">
            <h4 className="mb-2 font-semibold text-xs">
              Default Test Users (auto-seeded):
            </h4>
            <ul className="space-y-1 text-muted-foreground text-xs">
              <li className="flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 font-mono">
                  demo-user-feed-support
                </code>
                <span>→ Feed Support (default sender)</span>
              </li>
              <li className="flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 font-mono">
                  demo-user-welcome-bot
                </code>
                <span>→ Welcome Bot (click button to use)</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// Group Invite Section Component
function GroupInviteSection() {
  const [npcId, setNpcId] = useState("");
  const [userId, setUserId] = useState("");
  const [chatId, setChatId] = useState("");
  const [chatName, setChatName] = useState("");
  const [sending, setSending] = useState(false);

  const handleSendInvite = useCallback(async () => {
    if (!npcId.trim()) {
      toast.error("Please enter an NPC ID");
      return;
    }

    if (!userId.trim()) {
      toast.error("Please enter a user ID");
      return;
    }

    setSending(true);

    const token = getAuthToken();

    if (!token) {
      throw new Error("Not authenticated");
    }

    const response = await fetch(apiUrl("/api/admin/group-invite"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        npcId: npcId.trim(),
        userId: userId.trim(),
        chatId: chatId.trim() || undefined,
        chatName: chatName.trim() || undefined,
      }),
    });

    const data = await response.json();

    if (response.ok && data.success) {
      toast.success(data.message || "Group invite sent successfully");
      // Reset form
      setUserId("");
      setChatId("");
      setChatName("");
    } else {
      toast.error(data.error || data.message || "Failed to send group invite");
    }
    setSending(false);
  }, [npcId, userId, chatId, chatName]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <UserPlus className="h-5 w-5 text-primary" />
        <h2 className="font-semibold text-xl">Send Group Chat Invite</h2>
      </div>

      <p className="text-muted-foreground text-sm">
        Send a group chat invite to a user on behalf of an NPC. This will add
        the user to the NPC&apos;s group chat.
      </p>

      {/* Form */}
      <div className="space-y-4 rounded-lg border border-border bg-card p-6">
        {/* NPC ID */}
        <div>
          <label htmlFor="npcId" className="mb-2 block font-medium text-sm">
            NPC ID (Inviter) *
          </label>
          <input
            id="npcId"
            type="text"
            value={npcId}
            onChange={(e) => setNpcId(e.target.value)}
            placeholder="Enter NPC/Actor ID (e.g., actor-1, demo-user-...)"
            className={cn(
              "w-full rounded-lg border border-border px-4 py-2",
              "bg-background text-foreground",
              "focus:border-primary focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={sending}
          />
          <p className="mt-1 text-muted-foreground text-xs">
            The NPC that will send the invite. Check the Users tab or database
            for valid NPC IDs.
          </p>
        </div>

        {/* User ID */}
        <div>
          <label
            htmlFor="inviteUserId"
            className="mb-2 block font-medium text-sm"
          >
            User ID (Invitee) *
          </label>
          <input
            id="inviteUserId"
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="Enter user ID to invite"
            className={cn(
              "w-full rounded-lg border border-border px-4 py-2",
              "bg-background text-foreground",
              "focus:border-primary focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={sending}
          />
          <p className="mt-1 text-muted-foreground text-xs">
            The user who will receive the invite. Find user IDs in the Users
            tab.
          </p>
        </div>

        {/* Chat ID (Optional) */}
        <div>
          <label htmlFor="chatId" className="mb-2 block font-medium text-sm">
            Chat ID (Optional)
          </label>
          <input
            id="chatId"
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="Leave empty for auto-generated ID"
            className={cn(
              "w-full rounded-lg border border-border px-4 py-2",
              "bg-background text-foreground",
              "focus:border-primary focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={sending}
          />
          <p className="mt-1 text-muted-foreground text-xs">
            Optional. If empty, will use format: [npcId]-owned-chat
          </p>
        </div>

        {/* Chat Name (Optional) */}
        <div>
          <label htmlFor="chatName" className="mb-2 block font-medium text-sm">
            Chat Name (Optional)
          </label>
          <input
            id="chatName"
            type="text"
            value={chatName}
            onChange={(e) => setChatName(e.target.value)}
            placeholder="Leave empty for auto-generated name"
            className={cn(
              "w-full rounded-lg border border-border px-4 py-2",
              "bg-background text-foreground",
              "focus:border-primary focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={sending}
          />
          <p className="mt-1 text-muted-foreground text-xs">
            Optional. If empty, will use format: [NPC Name]&apos;s Inner Circle
          </p>
        </div>

        {/* Send Button */}
        <button
          onClick={handleSendInvite}
          disabled={sending || !npcId.trim() || !userId.trim()}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-lg px-6 py-3",
            "bg-primary font-semibold text-primary-foreground",
            "transition-colors hover:bg-primary/90",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <UserPlus className="h-4 w-4" />
          <span>{sending ? "Sending Invite..." : "Send Group Invite"}</span>
        </button>
      </div>

      {/* Info */}
      <div className="space-y-2 rounded-lg border border-blue-500/20 bg-blue-500/10 p-4">
        <h3 className="font-semibold text-blue-600 text-sm dark:text-blue-400">
          How it works:
        </h3>
        <ul className="list-inside list-disc space-y-1 text-blue-600 text-sm dark:text-blue-400">
          <li>The NPC will invite the user to their group chat</li>
          <li>A notification will be sent to the user</li>
          <li>The user will be added as a participant in the chat</li>
          <li>
            If the chat doesn&apos;t exist, it will be created automatically
          </li>
        </ul>
      </div>
    </div>
  );
}
