import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import MessageLoading from "./message-loading";
import { Button, type ButtonProps } from "../button";

// ChatBubble
const chatBubbleVariant = cva(
    "flex gap-2 max-w-[60%] items-end relative group",
    {
        variants: {
            variant: {
                received: "self-start",
                sent: "self-end flex-row-reverse",
            },
            layout: {
                default: "",
                ai: "max-w-full w-full items-center",
            },
        },
        defaultVariants: {
            variant: "received",
            layout: "default",
        },
    }
);

interface ChatBubbleProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof chatBubbleVariant> {}

const ChatBubble = React.forwardRef<HTMLDivElement, ChatBubbleProps>(
    ({ className, variant, layout, children, ...props }, ref) => (
        <div
            className={cn(
                chatBubbleVariant({ variant, layout, className }),
                "relative group"
            )}
            ref={ref}
            {...props}
        >
            {React.Children.map(children, (child) =>
                React.isValidElement(child) && typeof child.type !== "string"
                    ? React.cloneElement(child, {
                          variant,
                          layout,
                      } as React.ComponentProps<typeof child.type>)
                    : child
            )}
        </div>
    )
);
ChatBubble.displayName = "ChatBubble";

// ChatBubbleAvatar
interface ChatBubbleAvatarProps {
    src?: string;
    fallback?: string;
    className?: string;
}

const ChatBubbleAvatar: React.FC<ChatBubbleAvatarProps> = ({
    src,
    fallback,
    className,
}) => (
    <Avatar className={className}>
        <AvatarImage src={src} alt="Avatar" />
        <AvatarFallback>{fallback}</AvatarFallback>
    </Avatar>
);

// ChatBubbleMessage
const chatBubbleMessageVariants = cva("p-4", {
    variants: {
        variant: {
            received:
                "bg-secondary text-secondary-foreground rounded-r-lg rounded-tl-lg",
            sent: "bg-primary text-primary-foreground rounded-l-lg rounded-tr-lg",
        },
        layout: {
            default: "",
            ai: "border-t w-full rounded-none bg-transparent",
        },
    },
    defaultVariants: {
        variant: "received",
        layout: "default",
    },
});

interface ChatBubbleMessageProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof chatBubbleMessageVariants> {
    isLoading?: boolean;
}

const ChatBubbleMessage = React.forwardRef<
    HTMLDivElement,
    ChatBubbleMessageProps
>(
    (
        { className, variant, layout, isLoading = false, children, ...props },
        ref
    ) => (
        <div
            className={cn(
                chatBubbleMessageVariants({ variant, layout, className }),
                "break-words max-w-full whitespace-pre-wrap"
            )}
            ref={ref}
            {...props}
        >
            {isLoading ? (
                <div className="flex items-center space-x-2">
                    <MessageLoading />
                </div>
            ) : (
                children
            )}
        </div>
    )
);
ChatBubbleMessage.displayName = "ChatBubbleMessage";

// ChatBubbleTimestamp
interface ChatBubbleTimestampProps extends React.HTMLAttributes<HTMLDivElement> {
    timestamp: string;
}

const ChatBubbleTimestamp: React.FC<ChatBubbleTimestampProps> = ({
    timestamp,
    className,
    ...props
}) => (
    <div className={cn("text-xs text-right select-none", className)} {...props}>
        {timestamp}
    </div>
);

// ChatBubbleAction
type ChatBubbleActionProps = ButtonProps & {
    icon: React.ReactNode;
};

const ChatBubbleAction: React.FC<ChatBubbleActionProps> = ({
    icon,
    onClick,
    className,
    variant = "ghost",
    size = "icon",
    ...props
}) => (
    <Button
        variant={variant}
        size={size}
        className={className}
        onClick={onClick}
        {...props}
    >
        {icon}
    </Button>
);

interface ChatBubbleActionWrapperProps
    extends React.HTMLAttributes<HTMLDivElement> {
    variant?: "sent" | "received";
    className?: string;
}

const ChatBubbleActionWrapper = React.forwardRef<
    HTMLDivElement,
    ChatBubbleActionWrapperProps
>(({ variant, className, children, ...props }, ref) => (
    <div
        ref={ref}
        className={cn(
            "absolute top-1/2 -translate-y-1/2 flex opacity-0 group-hover:opacity-100 transition-opacity duration-200",
            variant === "sent"
                ? "-left-1 -translate-x-full flex-row-reverse"
                : "-right-1 translate-x-full",
            className
        )}
        {...props}
    >
        {children}
    </div>
));
ChatBubbleActionWrapper.displayName = "ChatBubbleActionWrapper";

export {
    ChatBubble,
    ChatBubbleAvatar,
    ChatBubbleMessage,
    ChatBubbleTimestamp,
    chatBubbleVariant,
    chatBubbleMessageVariants,
    ChatBubbleAction,
    ChatBubbleActionWrapper,
};
