export interface ApiParameterSelectOption {
    value: string;
    label: string;
}
export interface ApiParameterSelectProps {
    value?: string;
    onValueChange?: (value: string) => void;
    options: ApiParameterSelectOption[];
    placeholder?: string;
    className?: string;
}
export declare function ApiParameterSelect({ value, onValueChange, options, placeholder, className, }: ApiParameterSelectProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=api-parameter-select.d.ts.map