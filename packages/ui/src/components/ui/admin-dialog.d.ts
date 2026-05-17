import type * as React from "react";
import { DialogContent } from "./dialog";
import { type InputProps } from "./input";
export interface AdminDialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogContent> {
    className?: string;
    children?: React.ReactNode;
    container?: HTMLElement | null;
}
export declare function AdminDialogContent({ className, ...props }: AdminDialogContentProps): import("react/jsx-runtime").JSX.Element;
export interface AdminDialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
}
export declare function AdminDialogHeader({ className, ...props }: AdminDialogHeaderProps): import("react/jsx-runtime").JSX.Element;
export interface AdminDialogFooterProps extends React.HTMLAttributes<HTMLDivElement> {
}
export declare function AdminDialogFooterChrome({ className, ...props }: AdminDialogFooterProps): import("react/jsx-runtime").JSX.Element;
export interface AdminDialogBodyScrollProps extends React.HTMLAttributes<HTMLDivElement> {
}
export declare function AdminDialogBodyScroll({ className, ...props }: AdminDialogBodyScrollProps): import("react/jsx-runtime").JSX.Element;
export interface AdminMetaBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
}
export declare function AdminMetaBadge({ className, ...props }: AdminMetaBadgeProps): import("react/jsx-runtime").JSX.Element;
export interface AdminMonoMetaProps extends React.HTMLAttributes<HTMLSpanElement> {
}
export declare function AdminMonoMeta({ className, ...props }: AdminMonoMetaProps): import("react/jsx-runtime").JSX.Element;
export interface AdminInputProps extends InputProps {
}
export declare function AdminInput({ className, ...props }: AdminInputProps): import("react/jsx-runtime").JSX.Element;
export interface AdminCodeEditorProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
}
export declare function AdminCodeEditor({ className, ...props }: AdminCodeEditorProps): import("react/jsx-runtime").JSX.Element;
export interface AdminSegmentedTabListProps extends React.HTMLAttributes<HTMLDivElement> {
}
export declare function AdminSegmentedTabList({ className, ...props }: AdminSegmentedTabListProps): import("react/jsx-runtime").JSX.Element;
export interface AdminSegmentedTabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    active?: boolean;
}
export declare function AdminSegmentedTab({ active, className, ...props }: AdminSegmentedTabProps): import("react/jsx-runtime").JSX.Element;
export declare const AdminDialog: {
    Content: typeof AdminDialogContent;
    Header: typeof AdminDialogHeader;
    Footer: typeof AdminDialogFooterChrome;
    BodyScroll: typeof AdminDialogBodyScroll;
    MetaBadge: typeof AdminMetaBadge;
    MonoMeta: typeof AdminMonoMeta;
    Input: typeof AdminInput;
    CodeEditor: typeof AdminCodeEditor;
    SegmentedTabList: typeof AdminSegmentedTabList;
    SegmentedTab: typeof AdminSegmentedTab;
};
//# sourceMappingURL=admin-dialog.d.ts.map