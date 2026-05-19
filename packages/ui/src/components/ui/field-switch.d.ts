import * as React from "react";
export interface FieldSwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "checked" | "onChange" | "children"> {
    checked: boolean;
    label: React.ReactNode;
    onCheckedChange?: (checked: boolean) => void;
}
export declare const FieldSwitch: React.ForwardRefExoticComponent<FieldSwitchProps & React.RefAttributes<HTMLButtonElement>>;
//# sourceMappingURL=field-switch.d.ts.map