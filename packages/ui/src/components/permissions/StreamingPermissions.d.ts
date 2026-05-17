export type StreamingPermissionMode = "mobile" | "web";
type MediaPermissionId = "camera" | "microphone" | "screen";
export interface MediaPermissionDef {
    id: MediaPermissionId;
    name: string;
    nameKey: string;
    description: string;
    descriptionKey: string;
    icon: string;
    modes?: readonly StreamingPermissionMode[];
}
export declare function isStreamingPermissionVisibleForMode(def: MediaPermissionDef, mode: StreamingPermissionMode): boolean;
interface StreamingPermissionsSettingsViewProps {
    description: string;
    mode: StreamingPermissionMode;
    testId: string;
    title: string;
}
export declare function StreamingPermissionsSettingsView({ description, mode, testId, title, }: StreamingPermissionsSettingsViewProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=StreamingPermissions.d.ts.map