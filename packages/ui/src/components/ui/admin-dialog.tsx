import type * as React from "react";

import { cn } from "../../lib/utils";
import { DialogContent, DialogFooter, DialogHeader } from "./dialog";
import { Input, type InputProps } from "./input";

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
  return (
    <DialogContent
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/98 p-0 shadow-2xl",
        className,
      )}
      {...props}
    />
  );
}

export interface AdminDialogHeaderProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function AdminDialogHeader({
  className,
  ...props
}: AdminDialogHeaderProps) {
  return (
    <DialogHeader
      className={cn("shrink-0 bg-card/80 px-5 py-4", className)}
      {...props}
    />
  );
}

export interface AdminDialogFooterProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function AdminDialogFooterChrome({
  className,
  ...props
}: AdminDialogFooterProps) {
  return (
    <DialogFooter
      className={cn("shrink-0 bg-card/80 px-5 py-4", className)}
      {...props}
    />
  );
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
        "rounded-full border border-border/40 bg-bg-accent/80 px-2 py-0.5 text-2xs font-bold lowercase tracking-widest text-muted-strong",
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
    <span
      className={cn("text-2xs font-mono text-muted/70", className)}
      {...props}
    />
  );
}

export interface AdminInputProps extends InputProps {}

export function AdminInput({ className, ...props }: AdminInputProps) {
  return (
    <Input
      className={cn(
        "h-10 w-full rounded-xl border border-border/50 bg-card/85 px-3 text-sm font-mono text-txt shadow-inner transition-[border-color,box-shadow,background-color] placeholder:text-muted/60 focus-visible:ring-accent",
        className,
      )}
      {...props}
    />
  );
}

export interface AdminCodeEditorProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function AdminCodeEditor({ className, ...props }: AdminCodeEditorProps) {
  return (
    <textarea
      className={cn(
        "h-full w-full resize-none border-0 bg-bg-hover p-5 font-mono text-sm leading-relaxed text-txt focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset",
        className,
      )}
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
        "flex-1 rounded-none border-b-2 px-4 py-2.5 text-xs-tight font-bold tracking-[0.1em] transition-[border-color,color,background-color]",
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
