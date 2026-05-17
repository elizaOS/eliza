interface VoiceStatusBadgeProps {
  voice: {
    cloneType: "instant" | "professional";
    createdAt: Date | string;
    status?: "processing" | "completed" | "failed";
  };
}
export declare function VoiceStatusBadge({
  voice,
}: VoiceStatusBadgeProps): import("react/jsx-runtime").JSX.Element;
export declare function getEstimatedReadyMessage(voice: {
  cloneType: "instant" | "professional";
  createdAt: Date | string;
  name: string;
}): string;
//# sourceMappingURL=voice-status-badge.d.ts.map
