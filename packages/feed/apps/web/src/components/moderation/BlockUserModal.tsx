/**
 * Block user modal component for blocking users.
 *
 * Provides a confirmation modal for blocking users. Shows what blocking
 * will do (different behavior for NPCs vs real users). Includes optional
 * reason field. Handles API call and success/error states.
 *
 * Features:
 * - Confirmation dialog
 * - NPC vs user blocking behavior
 * - Optional reason field
 * - Loading states
 * - Error handling
 * - Body scroll lock and escape key handling
 *
 * @param props - BlockUserModal component props
 * @returns Block user modal element or null if not open
 *
 * @example
 * ```tsx
 * <BlockUserModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   targetUserId="user-123"
 *   targetDisplayName="Alice"
 *   onSuccess={() => refreshFeed()}
 * />
 * ```
 */
"use client";

import { Ban, X } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { apiUrl } from "@/utils/api-url";

interface BlockUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetUserId: string;
  targetDisplayName: string;
  isNPC?: boolean;
  onSuccess?: () => void;
}

export function BlockUserModal({
  isOpen,
  onClose,
  targetUserId,
  targetDisplayName,
  isNPC = false,
  onSuccess,
}: BlockUserModalProps) {
  const [reason, setReason] = useState("");
  const [isBlocking, startBlocking] = useTransition();

  const handleBlock = () => {
    startBlocking(async () => {
      const response = await fetch(apiUrl(`/api/users/${targetUserId}/block`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "block",
          reason: reason || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.message || "Failed to block user");
        return;
      }

      onClose();
      onSuccess?.();
    });
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm md:p-4"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col bg-card md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-md md:rounded-2xl md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-border border-b p-6">
          <h2 className="flex items-center gap-2 font-bold text-xl">
            <Ban className="h-5 w-5 text-orange-500" />
            Block User
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 transition-colors hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <p className="mb-4 text-muted-foreground">
            Are you sure you want to block <strong>{targetDisplayName}</strong>?
          </p>

          <div className="mb-4 rounded-lg border border-border bg-muted/50 p-3">
            <p className="text-muted-foreground text-sm">Blocking will:</p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-muted-foreground text-sm">
              {isNPC ? (
                <>
                  <li>Hide their posts from your feed</li>
                  <li>Prevent them from adding you to group chats</li>
                </>
              ) : (
                <>
                  <li>Remove them from your followers</li>
                  <li>Hide their posts from your feed</li>
                  <li>Prevent them from seeing your posts</li>
                  <li>Prevent them from messaging you</li>
                </>
              )}
            </ul>
          </div>

          <div>
            <label className="mb-2 block font-medium text-sm">
              Reason (optional)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you blocking this user?"
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 focus:border-primary focus:outline-none"
              rows={3}
              maxLength={500}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-border border-t p-6">
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={isBlocking}
              className="flex-1 rounded-lg bg-muted px-4 py-3 text-foreground transition-colors hover:bg-muted/80 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleBlock}
              disabled={isBlocking}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 text-white transition-colors hover:bg-orange-600 disabled:opacity-50"
            >
              {isBlocking ? (
                <>Blocking...</>
              ) : (
                <>
                  <Ban className="h-4 w-4" />
                  Block User
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
