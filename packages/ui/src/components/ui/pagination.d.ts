/**
 * Pagination component system for navigating through pages.
 * Provides previous/next navigation, page numbers, and ellipsis for large page counts.
 */
import type * as React from "react";
import { type Button } from "./button";
declare function Pagination({ className, ...props }: React.ComponentProps<"nav">): import("react/jsx-runtime").JSX.Element;
declare function PaginationContent({ className, ...props }: React.ComponentProps<"ul">): import("react/jsx-runtime").JSX.Element;
declare function PaginationItem({ ...props }: React.ComponentProps<"li">): import("react/jsx-runtime").JSX.Element;
type PaginationLinkProps = {
    isActive?: boolean;
} & Pick<React.ComponentProps<typeof Button>, "size"> & React.ComponentProps<"a">;
declare function PaginationLink({ className, isActive, size, ...props }: PaginationLinkProps): import("react/jsx-runtime").JSX.Element;
declare function PaginationPrevious({ className, ...props }: React.ComponentProps<typeof PaginationLink>): import("react/jsx-runtime").JSX.Element;
declare function PaginationNext({ className, ...props }: React.ComponentProps<typeof PaginationLink>): import("react/jsx-runtime").JSX.Element;
declare function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">): import("react/jsx-runtime").JSX.Element;
export { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious, };
//# sourceMappingURL=pagination.d.ts.map