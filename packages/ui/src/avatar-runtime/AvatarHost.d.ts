import type { AvatarSpeakingState } from "./types";
export interface AvatarHostProps {
    moduleId?: string;
    audioLevel?: () => number;
    speakingState?: () => AvatarSpeakingState;
    ownerName?: string;
    className?: string;
}
export declare function AvatarHost(props: AvatarHostProps): React.JSX.Element;
//# sourceMappingURL=AvatarHost.d.ts.map