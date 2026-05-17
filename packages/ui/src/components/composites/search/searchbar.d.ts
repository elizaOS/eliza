import * as React from "react";
export interface SearchBarProps {
    onSearch: (query: string) => void;
    searching?: boolean;
    placeholder?: string;
    /** Label for the submit button when idle. Defaults to "Search". */
    searchLabel?: string;
    /** Label for the submit button when busy. Defaults to "Searching...". */
    searchingLabel?: string;
}
export interface SidebarSearchBarProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
    onClear?: () => void;
    loading?: boolean;
    clearLabel?: string;
}
export declare function SearchBar({ onSearch, searching, placeholder, searchLabel, searchingLabel, }: SearchBarProps): import("react/jsx-runtime").JSX.Element;
export declare const SidebarSearchBar: React.ForwardRefExoticComponent<SidebarSearchBarProps & React.RefAttributes<HTMLInputElement>>;
//# sourceMappingURL=searchbar.d.ts.map