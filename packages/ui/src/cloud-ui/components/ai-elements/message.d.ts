import type { UIMessage } from "ai";
import { type VariantProps } from "class-variance-authority";
import type { ComponentProps, HTMLAttributes } from "react";
import { Avatar } from "../avatar";
/**
 * Message container component with role-based styling.
 *
 * @param props.from - Message role (user or assistant)
 */
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
    from: UIMessage["role"];
};
export declare const Message: ({ className, from, ...props }: MessageProps) => import("react/jsx-runtime").JSX.Element;
declare const messageContentVariants: (props?: ({
    variant?: "flat" | "contained" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
/**
 * Message content container with variant styling (contained or flat).
 *
 */
export type MessageContentProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof messageContentVariants>;
export declare const MessageContent: ({ children, className, variant, ...props }: MessageContentProps) => import("react/jsx-runtime").JSX.Element;
/**
 * Avatar component for message display.
 *
 * @param props.src - Image source URL
 * @param props.name - Optional name for alt text
 */
export type MessageAvatarProps = ComponentProps<typeof Avatar> & {
    src: string;
    name?: string;
};
export declare const MessageAvatar: ({ src, name, className, ...props }: MessageAvatarProps) => import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=message.d.ts.map