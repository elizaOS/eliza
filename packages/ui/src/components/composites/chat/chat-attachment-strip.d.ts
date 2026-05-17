import type { ChatAttachmentItem, ChatVariant } from "./chat-types";
export interface ChatAttachmentStripProps {
  items: ChatAttachmentItem[];
  onRemove: (id: string, index: number) => void;
  removeLabel?: (item: ChatAttachmentItem) => string;
  variant?: ChatVariant;
}
export declare function ChatAttachmentStrip({
  items,
  onRemove,
  removeLabel,
  variant,
}: ChatAttachmentStripProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=chat-attachment-strip.d.ts.map
