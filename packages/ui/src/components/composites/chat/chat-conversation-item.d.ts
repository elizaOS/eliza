import type React from "react";
import type {
  ChatConversationLabels,
  ChatConversationSummary,
  ChatVariant,
} from "./chat-types";
export interface ChatConversationItemProps {
  conversation: ChatConversationSummary;
  deleting?: boolean;
  displayTitle?: string;
  isActive: boolean;
  isConfirmingDelete?: boolean;
  isUnread?: boolean;
  labels?: ChatConversationLabels;
  mobile?: boolean;
  onCancelDelete?: () => void;
  onConfirmDelete?: () => void | Promise<void>;
  onOpenActions?: (
    event:
      | React.MouseEvent<HTMLButtonElement | HTMLDivElement>
      | React.TouchEvent<HTMLButtonElement | HTMLDivElement>,
    conversation: ChatConversationSummary,
  ) => void;
  onRequestDeleteConfirm?: () => void;
  onRequestRename?: () => void;
  onSelect: () => void;
  variant?: ChatVariant;
}
export declare function ChatConversationItem({
  conversation,
  deleting,
  displayTitle,
  isActive,
  isConfirmingDelete,
  isUnread,
  labels,
  mobile,
  onCancelDelete,
  onConfirmDelete,
  onOpenActions,
  onRequestDeleteConfirm,
  onRequestRename,
  onSelect,
  variant,
}: ChatConversationItemProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=chat-conversation-item.d.ts.map
