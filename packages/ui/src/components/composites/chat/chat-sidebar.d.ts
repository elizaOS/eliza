import type * as React from "react";
import { SidebarPanel, SidebarScrollRegion } from "../sidebar";
import { ChatConversationItem } from "./chat-conversation-item";
import { ChatConversationRenameDialog } from "./chat-conversation-rename-dialog";
import type {
  ChatConversationLabels,
  ChatConversationSummary,
  ChatVariant,
} from "./chat-types";
export interface ChatSidebarProps {
  activeConversationId: string | null;
  confirmDeleteId?: string | null;
  conversations: ChatConversationSummary[];
  deletingId?: string | null;
  labels?: ChatConversationLabels;
  mobile?: boolean;
  onCancelDelete?: () => void;
  onClose?: () => void;
  onConfirmDelete?: (id: string) => void | Promise<void>;
  onCreate: () => void;
  onOpenActions?: (
    event:
      | React.MouseEvent<HTMLButtonElement | HTMLDivElement>
      | React.TouchEvent<HTMLButtonElement | HTMLDivElement>,
    conversation: ChatConversationSummary,
  ) => void;
  onRequestDeleteConfirm?: (id: string) => void;
  onRequestRename?: (conversation: ChatConversationSummary) => void;
  onSearchChange?: React.ChangeEventHandler<HTMLInputElement>;
  onSearchClear?: () => void;
  onSelect: (id: string) => void;
  searchValue?: string;
  testId?: string;
  unreadConversations?: Set<string>;
  variant?: ChatVariant;
}
declare function ChatSidebarRoot({
  activeConversationId,
  confirmDeleteId,
  conversations,
  deletingId,
  labels,
  mobile,
  onCancelDelete,
  onClose,
  onConfirmDelete,
  onCreate,
  onOpenActions,
  onRequestDeleteConfirm,
  onRequestRename,
  onSearchChange,
  onSearchClear,
  onSelect,
  searchValue,
  testId,
  unreadConversations,
  variant,
}: ChatSidebarProps): import("react/jsx-runtime").JSX.Element;
export declare const ChatSidebar: typeof ChatSidebarRoot & {
  Content: {
    EmptyState: typeof import("..").SidebarEmptyState;
    ItemBody: typeof import("..").SidebarItemBody;
    ItemDescription: typeof import("..").SidebarItemDescription;
    ItemIcon: typeof import("..").SidebarItemIcon;
    ItemAction: typeof import("..").SidebarItemAction;
    ItemButton: React.ForwardRefExoticComponent<
      import("..").SidebarItemButtonProps &
        React.RefAttributes<HTMLButtonElement>
    >;
    ItemTitle: typeof import("..").SidebarItemTitle;
    Toolbar: typeof import("..").SidebarToolbar;
    ToolbarPrimary: typeof import("..").SidebarToolbarPrimary;
    ToolbarActions: typeof import("..").SidebarToolbarActions;
    SectionLabel: typeof import("..").SidebarSectionLabel;
    SectionHeader: typeof import("..").SidebarSectionHeader;
    Notice: typeof import("..").SidebarNotice;
    Item: React.ForwardRefExoticComponent<
      import("..").SidebarItemProps & React.RefAttributes<HTMLElement>
    >;
    RailMedia: typeof import("..").SidebarRailMedia;
    RailItem: React.ForwardRefExoticComponent<
      import("..").SidebarRailItemProps & React.RefAttributes<HTMLButtonElement>
    >;
  };
  Item: typeof ChatConversationItem;
  Panel: typeof SidebarPanel;
  RenameDialog: typeof ChatConversationRenameDialog;
  ScrollRegion: typeof SidebarScrollRegion;
};
//# sourceMappingURL=chat-sidebar.d.ts.map
