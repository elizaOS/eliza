export type CompanionRole = "agent" | "user";
export interface CompanionMessage {
  id: string;
  role: CompanionRole;
  text: string;
}
export interface CompactMessageStackProps {
  messages: readonly CompanionMessage[];
  collapsedCount?: number;
  className?: string;
}
export declare function CompactMessageStack(
  props: CompactMessageStackProps,
): React.JSX.Element;
//# sourceMappingURL=CompactMessageStack.d.ts.map
