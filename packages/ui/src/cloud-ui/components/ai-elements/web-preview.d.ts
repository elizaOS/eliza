/**
 * Web preview component for displaying web content in an iframe.
 * Supports URL input, console view, and navigation controls.
 *
 * @param props.defaultUrl - Default URL to display
 * @param props.onUrlChange - Callback when URL changes
 */
import type { ComponentProps, ReactNode } from "react";
import { Button } from "../button";
import { Input } from "../input";
export type WebPreviewContextValue = {
    url: string;
    setUrl: (url: string) => void;
    consoleOpen: boolean;
    setConsoleOpen: (open: boolean) => void;
};
export type WebPreviewProps = ComponentProps<"div"> & {
    defaultUrl?: string;
    onUrlChange?: (url: string) => void;
};
export declare const WebPreview: ({ className, children, defaultUrl, onUrlChange, ...props }: WebPreviewProps) => import("react/jsx-runtime").JSX.Element;
export type WebPreviewNavigationProps = ComponentProps<"div">;
export declare const WebPreviewNavigation: ({ className, children, ...props }: WebPreviewNavigationProps) => import("react/jsx-runtime").JSX.Element;
export type WebPreviewNavigationButtonProps = ComponentProps<typeof Button> & {
    tooltip?: string;
};
export declare const WebPreviewNavigationButton: ({ onClick, disabled, tooltip, children, ...props }: WebPreviewNavigationButtonProps) => import("react/jsx-runtime").JSX.Element;
export type WebPreviewUrlProps = ComponentProps<typeof Input>;
export declare const WebPreviewUrl: ({ value, onChange, onKeyDown, ...props }: WebPreviewUrlProps) => import("react/jsx-runtime").JSX.Element;
export type WebPreviewBodyProps = ComponentProps<"iframe"> & {
    loading?: ReactNode;
};
export declare const WebPreviewBody: ({ className, loading, src, ...props }: WebPreviewBodyProps) => import("react/jsx-runtime").JSX.Element;
export type WebPreviewConsoleProps = ComponentProps<"div"> & {
    logs?: Array<{
        level: "log" | "warn" | "error";
        message: string;
        timestamp: Date;
    }>;
};
export declare const WebPreviewConsole: ({ className, logs, children, ...props }: WebPreviewConsoleProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=web-preview.d.ts.map