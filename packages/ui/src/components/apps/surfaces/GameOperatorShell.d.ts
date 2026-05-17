export type GameOperatorEventTone =
  | "user"
  | "success"
  | "info"
  | "warning"
  | "error";
export interface GameOperatorEvent {
  id: string;
  label: string;
  message: string;
  tone?: GameOperatorEventTone;
  timestamp?: string | number | null;
}
export interface GameOperatorAction {
  id: string;
  label: string;
  command: string;
  testId?: string;
  active?: boolean;
  disabled?: boolean;
}
export interface GameOperatorDetail {
  label: string;
  value: string;
}
export interface GameOperatorShellProps {
  surfaceTestId: string;
  title: string;
  statusLabel: string;
  statusTone?: "live" | "attention" | "idle";
  objective: string | null;
  detailItems?: GameOperatorDetail[];
  primaryActions: GameOperatorAction[];
  suggestedActions?: GameOperatorAction[];
  events: GameOperatorEvent[];
  emptyEventsLabel: string;
  draft: string;
  inputPlaceholder: string;
  sendLabel?: string;
  sendingLabel?: string;
  canSend: boolean;
  sending: boolean;
  chatInputTestId: string;
  chatSendTestId: string;
  noticeTestId?: string;
  variant?: "detail" | "live" | "running";
  onDraftChange: (value: string) => void;
  onSendDraft: () => void;
  onCommand: (command: string) => void;
}
export declare function GameOperatorShell({
  surfaceTestId,
  title,
  statusLabel,
  statusTone,
  objective,
  detailItems,
  primaryActions,
  suggestedActions,
  events,
  emptyEventsLabel,
  draft,
  inputPlaceholder,
  sendLabel,
  sendingLabel,
  canSend,
  sending,
  chatInputTestId,
  chatSendTestId,
  noticeTestId,
  variant,
  onDraftChange,
  onSendDraft,
  onCommand,
}: GameOperatorShellProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=GameOperatorShell.d.ts.map
