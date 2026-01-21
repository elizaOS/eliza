import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Avatar component container.
 *
 * Container for avatar image and fallback. Styling is handled via className.
 *
 * @param props - Avatar component props
 * @returns Avatar container element
 *
 * @example
 * ```tsx
 * <Avatar>
 *   <AvatarImage src="/avatar.jpg" alt="User" />
 *   <AvatarFallback>JD</AvatarFallback>
 * </Avatar>
 * ```
 */
export type AvatarProps = React.ComponentPropsWithoutRef<"div">;

export const Avatar = ({ children, className, ...props }: AvatarProps) => {
  return (
    <div className={cn(className)} {...props}>
      {children}
    </div>
  );
};

/**
 * Avatar image component.
 *
 * Displays the avatar image with src and alt attributes.
 *
 * @param props - AvatarImage component props
 * @returns Avatar image element
 */
export interface AvatarImageProps
  extends React.ComponentPropsWithoutRef<"img"> {
  src?: string;
  alt?: string;
}

export const AvatarImage = ({
  src,
  alt,
  className,
  ...props
}: AvatarImageProps) => {
  return <img src={src} alt={alt} className={cn(className)} {...props} />;
};

/**
 * Avatar fallback component.
 *
 * Displays fallback content when avatar image fails to load.
 *
 * @param props - AvatarFallback component props
 * @returns Avatar fallback element
 */
export type AvatarFallbackProps = React.ComponentPropsWithoutRef<"div">;

export const AvatarFallback = ({
  children,
  className,
  ...props
}: AvatarFallbackProps) => {
  return (
    <div className={cn(className)} {...props}>
      {children}
    </div>
  );
};
