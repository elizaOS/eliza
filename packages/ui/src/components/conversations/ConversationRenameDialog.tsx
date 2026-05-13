import { useEffect, useState } from "react";
import { useApp } from "../../state";
import { ChatConversationRenameDialog } from "../composites/chat/chat-conversation-rename-dialog";

export interface ConversationRenameDialogProps {
  open: boolean;
  conversationId: string | null;
  /** Raw API title (not localized). */
  initialTitle: string;
  onClose: () => void;
}

export function ConversationRenameDialog({
  open,
  conversationId,
  initialTitle,
  onClose,
}: ConversationRenameDialogProps) {
  const { handleRenameConversation, suggestConversationTitle, t } = useApp();
  const [draft, setDraft] = useState(initialTitle);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(initialTitle);
      setSuggesting(false);
      setSaving(false);
    }
  }, [open, initialTitle]);

  const handleSuggest = async () => {
    if (!conversationId || suggesting || saving) return;
    setSuggesting(true);
    try {
      const suggested = await suggestConversationTitle(conversationId);
      if (suggested) setDraft(suggested);
    } finally {
      setSuggesting(false);
    }
  };

  const handleSave = async () => {
    if (!conversationId || saving || suggesting) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await handleRenameConversation(conversationId, trimmed);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ChatConversationRenameDialog
      open={open}
      title={t("conversations.renameDialogTitle")}
      description={t("conversations.renameDialogDescription")}
      inputLabel={t("conversations.renameDialogLabel")}
      value={draft}
      onChange={setDraft}
      onClose={onClose}
      onSave={() => void handleSave()}
      onSuggest={() => void handleSuggest()}
      saveDisabled={!conversationId || !draft.trim() || saving || suggesting}
      saveLabel={t("common.save")}
      savePendingLabel={t("conversations.renameDialogSaving")}
      saving={saving}
      suggestDisabled={!conversationId || suggesting || saving}
      suggestLabel={t("conversations.renameDialogSuggest")}
      suggestPendingLabel={t("conversations.renameDialogSuggesting")}
      suggesting={suggesting}
    />
  );
}
