import { cn } from "@feed/shared";
import type { HTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";

/**
 * Page container component for consistent page layout.
 *
 * Provides a standardized container with consistent padding and responsive
 * behavior. Supports optional padding removal and custom className.
 *
 * @param props - PageContainer component props
 * @returns Page container element
 *
 * @example
 * ```tsx
 * <PageContainer noPadding>
 *   <h1>Page Content</h1>
 * </PageContainer>
 * ```
 */
interface PageContainerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  children: ReactNode;
  className?: string;
  noPadding?: boolean;
}

export const PageContainer = forwardRef<HTMLDivElement, PageContainerProps>(
  ({ children, className, noPadding = false, ...rest }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          // Sharp corners, simple boxy layout
          "overflow-x-hidden bg-background",
          "h-full min-h-full w-full",
          // Desktop: Simple container - use full height
          "md:h-full",
          // Consistent padding: 16px mobile, 24px desktop
          !noPadding && "px-4 md:px-6",
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

PageContainer.displayName = "PageContainer";
