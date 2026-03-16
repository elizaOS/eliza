/**
 * Truncated wallet address with a copy button.
 */

import { useTimeout } from "@elizaos/app-core/hooks";
import { Button } from "@elizaos/ui";
import { useState } from "react";

export function CopyableAddress({
  address,
  onCopy,
}: {
  address: string;
  onCopy: (text: string) => Promise<void>;
}) {
  const { setTimeout } = useTimeout();
  const [copied, setCopied] = useState(false);
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;

  const handleCopy = async () => {
    await onCopy(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <code className="font-mono text-xs text-muted select-all" title={address}>
        {short}
      </code>
      <Button
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className="h-6 px-1.5 py-0.5 border-border bg-bg text-[10px] font-mono shadow-sm hover:border-accent hover:text-txt"
      >
        {copied ? "copied" : "copy"}
      </Button>
    </div>
  );
}
