import cn from "classnames";
import { User } from "lucide-react";
import { useState, type ComponentPropsWithRef, type ReactElement } from "react";

import {
  ROUNDED_CLASSES,
  type ColorVariant,
  type ComponentSize,
} from "./shared.ts";

export type AvatarSize = Extract<
  ComponentSize,
  "4" | "6" | "8" | "9" | "10" | "11" | "12" | "16"
>;

const sizeClasses: Record<AvatarSize, string> = {
  "4": "size-4 text-xs",
  "6": "size-6 text-xs",
  "8": "size-8 text-xs",
  "9": "size-9 text-sm",
  "10": "size-10 text-base",
  "11": "size-11 text-lg",
  "12": "size-12 text-xl",
  "16": "size-16 text-2xl",
};

const iconSizeClasses: Record<AvatarSize, string> = {
  "4": "size-3",
  "6": "size-4",
  "8": "size-6",
  "9": "size-7",
  "10": "size-8",
  "11": "size-9",
  "12": "size-10",
  "16": "size-12",
};

const textSizeClasses: Record<AvatarSize, string> = {
  "4": "text-xs",
  "6": "text-xs",
  "8": "text-xs",
  "9": "text-sm",
  "10": "text-base",
  "11": "text-lg",
  "12": "text-xl",
  "16": "text-2xl",
};

const bgColorClasses: Record<ColorVariant, string> = {
  gray: "bg-gray-600 dark:bg-gray-500",
  red: "bg-red-600 dark:bg-red-500",
  orange: "bg-orange-600 dark:bg-orange-500",
  yellow: "bg-yellow-600 dark:bg-yellow-500",
  teal: "bg-teal-600 dark:bg-teal-500",
  indigo: "bg-indigo-600 dark:bg-indigo-500",
  purple: "bg-purple-600 dark:bg-purple-500",
  sky: "bg-sky-600 dark:bg-sky-500",
  cyan: "bg-cyan-600 dark:bg-cyan-500",
  emerald: "bg-emerald-600 dark:bg-emerald-500",
};

export type AvatarProps = ComponentPropsWithRef<"div"> & {
  /**
   * The image source for the avatar
   */
  src?: string;
  /**
   * The alt text for the avatar
   */
  alt?: string;
  /**
   * The size of the avatar
   * @default "md"
   */
  size?: AvatarSize;
  /**
   * The border radius of the avatar
   * @default "full"
   */
  rounded?: "none" | "sm" | "md" | "lg" | "full";
  /**
   * Background color theme for the letter avatar
   * Uses the unified color theme system
   * @default "gray"
   */
  bgColor?: ColorVariant;
  /**
   * Text color for the letter avatar
   * @default "white"
   */
  textColor?: "white" | "black";
  /**
   * Custom letter to display (will use first letter of alt if not provided)
   */
  letter?: string;
  /**
   * Optional className for additional styling
   */
  className?: string;
};

export const Avatar = ({
  src,
  alt = "Avatar",
  size = "10",
  rounded = "full",
  bgColor = "gray",
  textColor = "white",
  letter,
  className = "",
  ...rest
}: AvatarProps): ReactElement => {
  const [error, setError] = useState(false);

  const displayLetter = letter ? letter.charAt(0) : alt.charAt(0).toUpperCase();

  const actualTextColor = textColor === "white" ? "text-white" : "text-black";

  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden",
        "bg-gray-200 dark:bg-gray-700",
        error && "border border-gray-200 dark:border-gray-800",
        sizeClasses[size],
        textSizeClasses[size],
        ROUNDED_CLASSES[rounded],
        className,
      )}
      {...rest}
    >
      {error ? (
        <User
          className={cn(
            iconSizeClasses[size],
            "text-gray-600 dark:text-gray-400",
          )}
        />
      ) : (
        <>
          {src ? (
            <img
              src={src}
              alt={alt}
              className="h-full w-full object-cover"
              onError={() => setError(true)}
            />
          ) : (
            <div
              className={cn(
                "flex h-full w-full items-center justify-center",
                bgColorClasses[bgColor],
                actualTextColor,
                "font-medium",
              )}
            >
              {displayLetter}
            </div>
          )}
        </>
      )}
    </div>
  );
};
