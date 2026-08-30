/**
 * Avatar component system built on Radix UI primitives.
 * Provides image display with fallback support for user avatars.
 */
"use client";

import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type * as React from "react";

import { cn } from "../../lib/utils";

export type AvatarFallbackTone =
  | "default"
  | "muted"
  | "chainEthereum"
  | "chainBase"
  | "chainBsc"
  | "chainAvalanche"
  | "chainArbitrum"
  | "chainOptimism"
  | "chainPolygon"
  | "chainSolana";

function Avatar({
  className,
  presentation = "default",
  shape = "circle",
  size,
  style,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  shape?: "circle" | "square";
  presentation?: "default" | "walletLogo";
  /** Runtime image dimensions; dynamic sizing remains owned by the atom. */
  size?: number;
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 overflow-hidden",
        shape === "circle" ? "rounded-full" : "rounded-sm",
        presentation === "walletLogo" &&
          "inline-flex items-center justify-center object-cover font-mono font-bold",
        className,
      )}
      style={
        size === undefined ? style : { ...style, width: size, height: size }
      }
      {...props}
    />
  );
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  );
}

function AvatarFallback({
  className,
  shape = "circle",
  tone = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback> & {
  shape?: "circle" | "square";
  tone?: AvatarFallbackTone;
}) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center text-txt-strong",
        shape === "circle" ? "rounded-full" : "rounded-sm",
        tone === "default" && "bg-bg-muted",
        tone === "muted" && "bg-muted",
        tone === "chainEthereum" && "bg-chain-eth",
        tone === "chainBase" && "bg-chain-base",
        tone === "chainBsc" && "bg-chain-bsc",
        tone === "chainAvalanche" && "bg-chain-avax",
        tone === "chainArbitrum" && "bg-chain-arb",
        tone === "chainOptimism" && "bg-chain-op",
        tone === "chainPolygon" && "bg-chain-pol",
        tone === "chainSolana" && "bg-chain-sol",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarFallback, AvatarImage };
