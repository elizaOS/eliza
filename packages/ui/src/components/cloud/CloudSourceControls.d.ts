export type CloudSourceMode = "cloud" | "own-key";
export declare function CloudSourceModeToggle({
  mode,
  onChange,
  cloudLabel,
  ownKeyLabel,
}: {
  mode: CloudSourceMode;
  onChange: (mode: CloudSourceMode) => void;
  cloudLabel?: string;
  ownKeyLabel?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function CloudConnectionStatus({
  connected,
  connectedText,
  disconnectedText,
}: {
  connected: boolean;
  connectedText?: string;
  disconnectedText: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=CloudSourceControls.d.ts.map
