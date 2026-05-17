import { type ComponentProps } from "react";
import { Button } from "../../ui/button";
export interface CreateTaskPopoverProps {
    chatInput: string;
    disabled: boolean;
    onCreateTask: (description: string, agentType: string) => void;
    t: (key: string, options?: Record<string, unknown>) => string;
    triggerClassName?: string;
    triggerIconClassName?: string;
    triggerVariant?: ComponentProps<typeof Button>["variant"];
}
export declare function CreateTaskPopover({ chatInput, disabled, onCreateTask, t, triggerClassName, triggerIconClassName, triggerVariant, }: CreateTaskPopoverProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=create-task-popover.d.ts.map