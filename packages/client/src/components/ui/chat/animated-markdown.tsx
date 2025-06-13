"use client";

import * as React from "react";
import AIWriter from "react-aiwriter";
import { Markdown } from "./markdown";

interface AnimatedMarkdownProps {
  children: string;
  className?: string;
  variant?: "user" | "agent";
  shouldAnimate?: boolean;
  messageId?: string;
}

export const AnimatedMarkdown: React.FC<AnimatedMarkdownProps> = ({
  children,
  className,
  variant = "agent",
  shouldAnimate = false,
  messageId,
}) => {
  const [animationComplete, setAnimationComplete] = React.useState(!shouldAnimate);

  // Reset animation state when message changes
  React.useEffect(() => {
    if (shouldAnimate) {
      setAnimationComplete(false);
      // Estimate animation time based on text length (50ms per character roughly)
      const estimatedTime = Math.min(children.length * 50, 3000);
      const timer = setTimeout(() => {
        setAnimationComplete(true);
      }, estimatedTime);

      return () => clearTimeout(timer);
    } else {
      setAnimationComplete(true);
    }
  }, [children, shouldAnimate, messageId]);

  // If not animating or animation is complete, render markdown
  if (!shouldAnimate || animationComplete) {
    return (
      <Markdown className={className} variant={variant}>
        {children}
      </Markdown>
    );
  }

  // During animation, show AIWriter with plain text
  return (
    <div className={className}>
      <AIWriter>{children}</AIWriter>
    </div>
  );
};