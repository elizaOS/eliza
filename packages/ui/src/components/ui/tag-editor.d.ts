export interface TagEditorProps {
    items: string[];
    onChange: (items: string[]) => void;
    label?: string;
    placeholder?: string;
    className?: string;
    maxItems?: number;
    addLabel?: string;
    removeLabel?: string;
}
export declare function TagEditor({ items, onChange, label, placeholder, className, maxItems, addLabel, removeLabel, }: TagEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=tag-editor.d.ts.map