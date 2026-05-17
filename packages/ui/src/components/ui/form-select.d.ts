import type * as SelectPrimitive from "@radix-ui/react-select";
import * as React from "react";
import { Select } from "./select";
export interface FormSelectProps extends React.ComponentProps<typeof Select> {
    children: React.ReactNode;
    placeholder?: string;
    triggerClassName?: string;
    contentClassName?: string;
    value?: string;
    onValueChange?: (value: string) => void;
}
export declare function FormSelect({ children, contentClassName, placeholder, triggerClassName, ...props }: FormSelectProps): import("react/jsx-runtime").JSX.Element;
export declare const FormSelectItem: React.ForwardRefExoticComponent<Omit<SelectPrimitive.SelectItemProps & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=form-select.d.ts.map