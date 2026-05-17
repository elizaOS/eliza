export type ComposerMode = "idle" | "voice" | "dictate";
export interface ComposerBarProps {
  onSend?: (text: string) => void;
  onDictateStart?: () => void;
  onDictateStop?: (text: string) => void;
  onVoiceStart?: () => void;
  onVoiceStop?: () => void;
  onAttach?: () => void;
  placeholder?: string;
  className?: string;
}
export declare function describeRightButton(args: {
  hasText: boolean;
  mode: ComposerMode;
}): "send" | "voice" | "check";
export declare function ComposerBar(props: ComposerBarProps): React.JSX.Element;
//# sourceMappingURL=ComposerBar.d.ts.map
