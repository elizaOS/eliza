import * as React from "react";
export interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
    /** Called when the clear button is clicked */
    onClear?: () => void;
    /** Show a loading indicator */
    loading?: boolean;
    /** Aria-label for the clear button */
    clearLabel?: string;
}
export declare const SearchInput: React.ForwardRefExoticComponent<SearchInputProps & React.RefAttributes<HTMLInputElement>>;
//# sourceMappingURL=search-input.d.ts.map