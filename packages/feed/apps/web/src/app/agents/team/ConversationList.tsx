'use client';

import { cn } from '@babylon/shared';
import {
  Check,
  Loader2,
  MessageCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  canDeleteConversation,
  getConversationDisplayName,
} from './conversation-utils';

/** Conversation info */
interface ConversationInfo {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
}

interface ConversationListProps {
  conversations: ConversationInfo[];
  loading?: boolean;
  onNewChat: () => void;
  onSelectConversation: (chatId: string) => void;
  onRenameConversation?: (chatId: string, newName: string) => Promise<void>;
  onDeleteConversation?: (chatId: string) => Promise<void>;
  /** Called when a link is clicked (for closing drawer on mobile) */
  onClose?: () => void;
}

/**
 * Conversation list component for Agents sidebar
 *
 * Shows all conversations in the team chat.
 * Allows creating new conversations (fresh chat).
 * Hover over a conversation to show rename button.
 */
export function ConversationList({
  conversations,
  loading = false,
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onClose,
}: ConversationListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const handleSelectConversation = (chatId: string) => {
    if (editingId) return; // Don't switch while editing
    onSelectConversation(chatId);
    onClose?.();
  };

  const handleStartEdit = (
    e: React.MouseEvent,
    conversation: ConversationInfo
  ) => {
    e.stopPropagation(); // Prevent selecting the conversation
    if (!onRenameConversation) return;
    setEditingId(conversation.id);
    // Use display name as initial edit value
    setEditValue(getConversationDisplayName(conversation));
  };

  const handleDeleteConversation = async (
    e: React.MouseEvent,
    conversation: ConversationInfo
  ) => {
    e.stopPropagation();
    if (!onDeleteConversation) return;
    if (!canDeleteConversation(conversations.length)) return;
    if (deletingId) return;

    const confirmed = window.confirm(
      'Delete this conversation? This action cannot be undone.'
    );
    if (!confirmed) return;

    if (editingId === conversation.id) {
      setEditingId(null);
      setEditValue('');
    }

    setDeletingId(conversation.id);
    try {
      await onDeleteConversation(conversation.id);
    } catch {
      // onDeleteConversation is responsible for user-facing error feedback
    } finally {
      setDeletingId(null);
    }
  };

  const handleSaveRename = async () => {
    if (!editingId || !onRenameConversation || !editValue.trim()) {
      setEditingId(null);
      return;
    }

    setIsSaving(true);
    try {
      await onRenameConversation(editingId, editValue.trim());
    } catch {
      // onRenameConversation is responsible for user-facing error feedback
    } finally {
      setIsSaving(false);
      setEditingId(null);
    }
  };

  const handleCancelRename = () => {
    setEditingId(null);
    setEditValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === 'Escape') {
      handleCancelRename();
    }
  };

  return (
    <div className="space-y-2">
      {/* Header with New Chat button */}
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-foreground text-xl">Chats</h2>
        <button
          type="button"
          onClick={onNewChat}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="New chat"
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>

      {/* Conversation list */}
      <div className="max-h-[200px] space-y-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <MessageCircle className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
            <p className="font-medium text-muted-foreground text-sm">
              No conversations yet
            </p>
            <p className="text-muted-foreground/70 text-xs">
              Start a new chat with your team
            </p>
          </div>
        ) : (
          conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={cn(
                'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                conversation.isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {editingId === conversation.id ? (
                // Inline edit mode
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={isSaving}
                    className="h-6 min-w-0 flex-1 rounded border border-primary/50 bg-background px-1.5 text-sm outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    onClick={handleSaveRename}
                    disabled={isSaving}
                    className="shrink-0 p-0.5 text-primary hover:text-primary/80"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelRename}
                    disabled={isSaving}
                    className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                // Normal display mode
                <>
                  <button
                    type="button"
                    onClick={() => handleSelectConversation(conversation.id)}
                    className="flex-1 truncate text-left text-sm"
                  >
                    {getConversationDisplayName(conversation)}
                  </button>
                  {(onRenameConversation || onDeleteConversation) && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {onRenameConversation && (
                        <button
                          type="button"
                          onClick={(e) => handleStartEdit(e, conversation)}
                          className="rounded p-0.5 text-muted-foreground opacity-100 transition-opacity hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
                          title="Rename"
                          aria-label="Rename conversation"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                      {onDeleteConversation && (
                        <button
                          type="button"
                          onClick={(e) =>
                            handleDeleteConversation(e, conversation)
                          }
                          disabled={
                            deletingId !== null ||
                            !canDeleteConversation(conversations.length)
                          }
                          className="rounded p-0.5 text-muted-foreground opacity-100 transition-opacity hover:text-destructive disabled:cursor-not-allowed disabled:text-muted-foreground/40 md:opacity-0 md:group-hover:opacity-100"
                          title={
                            canDeleteConversation(conversations.length)
                              ? 'Delete'
                              : 'Cannot delete the only conversation'
                          }
                          aria-label="Delete conversation"
                        >
                          {deletingId === conversation.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
