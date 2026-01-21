import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Card component for displaying content in a contained card layout.
 *
 * Base card container component. Styling is handled via className.
 *
 * @param props - Card component props
 * @returns Card element
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Title</CardTitle>
 *   </CardHeader>
 *   <CardContent>Content</CardContent>
 * </Card>
 * ```
 */
export const Card = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) => (
  <div className={cn(className)} {...props}>
    {children}
  </div>
);
/**
 * Card header component for card title and description.
 *
 * Container for card header content (title, description).
 *
 * @param props - CardHeader component props
 * @returns Card header element
 */
export const CardHeader = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) => (
  <div className={cn(className)} {...props}>
    {children}
  </div>
);
/**
 * Card title component.
 *
 * Displays the card title as an h3 element.
 *
 * @param props - CardTitle component props
 * @returns Card title element
 */
export const CardTitle = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"h3">) => (
  <h3 className={cn(className)} {...props}>
    {children}
  </h3>
);
/**
 * Card description component.
 *
 * Displays card description text as a paragraph element.
 *
 * @param props - CardDescription component props
 * @returns Card description element
 */
export const CardDescription = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"p">) => (
  <p className={cn(className)} {...props}>
    {children}
  </p>
);
/**
 * Card content component for main card body.
 *
 * Container for main card content.
 *
 * @param props - CardContent component props
 * @returns Card content element
 */
export const CardContent = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) => (
  <div className={cn(className)} {...props}>
    {children}
  </div>
);
