import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RotateCcw } from 'lucide-react';

interface RetryButtonProps {
    onClick: () => void;
    className?: string;
}

export default function RetryButton({ onClick, className }: RetryButtonProps) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className={`text-muted-foreground ${className}`}
                    onClick={onClick}
                >
                    <RotateCcw className="size-3" />
                </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
                <p>Retry message</p>
            </TooltipContent>
        </Tooltip>
    );
} 