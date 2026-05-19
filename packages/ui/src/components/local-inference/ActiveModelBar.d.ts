import type { ActiveModelState, InstalledModel } from "../../api/client-local-inference";
interface ActiveModelBarProps {
    active: ActiveModelState;
    installed: InstalledModel[];
    onUnload: () => void;
    busy: boolean;
}
export declare function ActiveModelBar({ active, installed, onUnload, busy, }: ActiveModelBarProps): import("react/jsx-runtime").JSX.Element | null;
export {};
//# sourceMappingURL=ActiveModelBar.d.ts.map