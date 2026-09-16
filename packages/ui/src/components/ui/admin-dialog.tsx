/**
 * Chrome parts for admin-console dialogs — a namespaced set (`AdminDialog.*`)
 * layered on the base Dialog primitive (`./dialog`): flush-padded content,
 * sticky card-tinted header/footer, a scrollable body, mono/badge metadata
 * spans, a mono input + code editor, and a segmented tab strip. Provides the
 * denser, edge-to-edge admin layout in place of the default centered padding.
 */
import type * as React from "react";
import { forwardRef } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "./badge";
import { DialogContent, DialogFooter, DialogHeader } from "./dialog";
import { Input, type InputProps } from "./input";
import { Textarea, type TextareaProps } from "./textarea";

export interface AdminDialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogContent> {
  className?: string;
  children?: React.ReactNode;
  container?: HTMLElement | null;
}

export function AdminDialogContent({
  className,
  ...props
}: AdminDialogContentProps) {
  return <DialogContent variant="admin" className={className} {...props} />;
}

export interface AdminDialogHeaderProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function AdminDialogHeader({
  className,
  ...props
}: AdminDialogHeaderProps) {
  return <DialogHeader variant="admin" className={className} {...props} />;
}

export interface AdminDialogFooterProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function AdminDialogFooterChrome({
  className,
  ...props
}: AdminDialogFooterProps) {
  return <DialogFooter variant="admin" className={className} {...props} />;
}

export interface AdminDialogBodyScrollProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function AdminDialogBodyScroll({
  className,
  ...props
}: AdminDialogBodyScrollProps) {
  return (
    <div
      className={cn("custom-scrollbar flex-1 overflow-y-auto", className)}
      {...props}
    />
  );
}

export interface AdminMetaBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {}

export function AdminMetaBadge({ className, ...props }: AdminMetaBadgeProps) {
  return (
    <span
      className={cn(
        "rounded-sm border border-border bg-bg-accent px-2 py-0.5 text-2xs font-bold lowercase tracking-widest text-muted-strong",
        className,
      )}
      {...props}
    />
  );
}

export interface AdminMonoMetaProps
  extends React.HTMLAttributes<HTMLSpanElement> {}

export function AdminMonoMeta({ className, ...props }: AdminMonoMetaProps) {
  return (
    <Badge asChild variant="adminMono" className={className}>
      <span {...props} />
    </Badge>
  );
}

export interface AdminInputProps extends InputProps {}

export const AdminInput = forwardRef<HTMLInputElement, AdminInputProps>(
  function AdminInput({ className, ...props }, ref) {
    return <Input ref={ref} variant="admin" className={className} {...props} />;
  },
);

export interface AdminCodeEditorProps extends TextareaProps {}

export function AdminCodeEditor({ className, ...props }: AdminCodeEditorProps) {
  return (
    <Textarea
      variant="adminCodeEditor"
      className={cn("h-full", className)}
      {...props}
    />
  );
}

export interface AdminSegmentedTabListProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function AdminSegmentedTabList({
  className,
  ...props
}: AdminSegmentedTabListProps) {
  return <div className={cn("flex bg-bg-accent/35", className)} {...props} />;
}

export interface AdminSegmentedTabProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function AdminSegmentedTab({
  active = false,
  className,
  ...props
}: AdminSegmentedTabProps) {
  return (
    <button
      type="button"
      className={cn(
        "flex-1 rounded-none border-b px-4 py-2.5 text-xs-tight font-bold tracking-[0.1em] transition-[border-color,color,background-color]",
        active
          ? "border-accent text-accent"
          : "border-transparent text-muted-strong hover:text-txt",
        className,
      )}
      {...props}
    />
  );
}

export const AdminDialog = {
  Content: AdminDialogContent,
  Header: AdminDialogHeader,
  Footer: AdminDialogFooterChrome,
  BodyScroll: AdminDialogBodyScroll,
  MetaBadge: AdminMetaBadge,
  MonoMeta: AdminMonoMeta,
  Input: AdminInput,
  CodeEditor: AdminCodeEditor,
  SegmentedTabList: AdminSegmentedTabList,
  SegmentedTab: AdminSegmentedTab,
};
