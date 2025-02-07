import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const CopyButton = ({ text }: { text: string }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
        });
    };

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    onClick={handleCopy}
                    variant="ghost"
                    size="icon"
                    className="flex items-center space-x-2 text-muted-foreground"
                >
                    {copied ? (
                        <Check className="size-4" />
                    ) : (
                        <Copy className="size-4" />
                    )}
                </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
                <p>Copy</p>
            </TooltipContent>
        </Tooltip>
    );
};

export default CopyButton;
