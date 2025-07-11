'use client';

import * as React from 'react';
import { Markdown } from './markdown';

interface AnimatedMarkdownProps {
  children: string;
  className?: string;
  variant?: 'user' | 'agent';
  shouldAnimate?: boolean;
  messageId?: string;
  maxDurationMs?: number; // Optional prop to control cap duration
}

export const AnimatedMarkdown: React.FC<AnimatedMarkdownProps> = ({
  children,
  className,
  variant = 'agent',
  shouldAnimate = false,
  messageId,
  maxDurationMs = 10000,
}) => {
  const [visibleText, setVisibleText] = React.useState(shouldAnimate ? '' : children);

  React.useEffect(() => {
    if (!shouldAnimate || !children.trim()) {
      setVisibleText(children);
      return;
    }

    const safeDuration = Math.max(1000, maxDurationMs);

    setVisibleText('');

    const TYPING_INTERVAL = 20;
    const totalChars = children.length;
    const totalSteps = Math.ceil(safeDuration / TYPING_INTERVAL);
    const charsPerStep = Math.max(1, Math.ceil(totalChars / totalSteps));

    let visibleCharCount = 0;
    const interval = setInterval(() => {
      visibleCharCount += charsPerStep;
      if (visibleCharCount >= totalChars) {
        setVisibleText(children);
        clearInterval(interval);
      } else {
        setVisibleText(children.slice(0, visibleCharCount));
      }
    }, TYPING_INTERVAL);

    return () => clearInterval(interval);
  }, [children, shouldAnimate, messageId, maxDurationMs]);

  return (
    <Markdown className={className} variant={variant}>
      {visibleText}
    </Markdown>
  );
};
