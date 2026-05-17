import type { ReactNode } from "react";
import { type CompanionMessage } from "./CompactMessageStack";
import { type ComposerBarProps } from "./ComposerBar";
export interface CompanionShellProps extends ComposerBarProps {
    messages: readonly CompanionMessage[];
    avatarModuleId?: string;
    audioLevel?: () => number;
    ownerName?: string;
    className?: string;
    headerSlot?: ReactNode;
    footerSlot?: ReactNode;
}
export declare function CompanionShell(props: CompanionShellProps): React.JSX.Element;
//# sourceMappingURL=CompanionShell.d.ts.map