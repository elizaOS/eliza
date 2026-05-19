/**
 * Inline citation component for displaying source citations in AI responses.
 * Supports hover cards, carousel navigation, and citation source display.
 */
import { type ComponentProps } from "react";
import { Badge } from "../badge";
import { Carousel } from "../carousel";
import { HoverCard } from "../hover-card";
export type InlineCitationProps = ComponentProps<"span">;
export declare const InlineCitation: ({ className, ...props }: InlineCitationProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationTextProps = ComponentProps<"span">;
export declare const InlineCitationText: ({ className, ...props }: InlineCitationTextProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCardProps = ComponentProps<typeof HoverCard>;
export declare const InlineCitationCard: (props: InlineCitationCardProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCardTriggerProps = ComponentProps<typeof Badge> & {
    sources: string[];
};
export declare const InlineCitationCardTrigger: ({ sources, className, ...props }: InlineCitationCardTriggerProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCardBodyProps = ComponentProps<"div">;
export declare const InlineCitationCardBody: ({ className, ...props }: InlineCitationCardBodyProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCarouselProps = ComponentProps<typeof Carousel>;
export declare const InlineCitationCarousel: ({ className, children, ...props }: InlineCitationCarouselProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCarouselContentProps = ComponentProps<"div">;
export declare const InlineCitationCarouselContent: (props: InlineCitationCarouselContentProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCarouselItemProps = ComponentProps<"div">;
export declare const InlineCitationCarouselItem: ({ className, ...props }: InlineCitationCarouselItemProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCarouselHeaderProps = ComponentProps<"div">;
export declare const InlineCitationCarouselHeader: ({ className, ...props }: InlineCitationCarouselHeaderProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCarouselIndexProps = ComponentProps<"div">;
export declare const InlineCitationCarouselIndex: ({ children, className, ...props }: InlineCitationCarouselIndexProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCarouselPrevProps = ComponentProps<"button">;
export declare const InlineCitationCarouselPrev: ({ className, ...props }: InlineCitationCarouselPrevProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationCarouselNextProps = ComponentProps<"button">;
export declare const InlineCitationCarouselNext: ({ className, ...props }: InlineCitationCarouselNextProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationSourceProps = ComponentProps<"div"> & {
    title?: string;
    url?: string;
    description?: string;
};
export declare const InlineCitationSource: ({ title, url, description, className, children, ...props }: InlineCitationSourceProps) => import("react/jsx-runtime").JSX.Element;
export type InlineCitationQuoteProps = ComponentProps<"blockquote">;
export declare const InlineCitationQuote: ({ children, className, ...props }: InlineCitationQuoteProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=inline-citation.d.ts.map