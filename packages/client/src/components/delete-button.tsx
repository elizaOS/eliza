import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface DeleteButtonProps {
  onClick: () => void;
}

const DeleteButton = ({ onClick }: DeleteButtonProps) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button onClick={onClick} variant="ghost" size="icon" className="text-muted-foreground">
          <Trash2 className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>Delete</p>
      </TooltipContent>
    </Tooltip>
  );
};

export default DeleteButton;
