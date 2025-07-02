import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Plus, Settings } from 'lucide-react';
import React from 'react';
import { useNavigate } from 'react-router-dom';

const AddAgentCard: React.FC = () => {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate('/create');
  };

  const handleCardClick = (e: React.MouseEvent) => {
    // Only trigger if clicking on the card background, not on interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('button')) {
      return;
    }
    handleClick();
  };

  return (
    <Card
      className="w-full cursor-pointer hover:shadow-lg transition-all border-2 border-dashed border-muted-foreground/30 bg-card/50 hover:bg-card/80"
      onClick={handleCardClick}
      onKeyPress={(e) => e.key === 'Enter' && handleClick()}
      tabIndex={0}
      role="button"
      aria-label="Create new agent"
      data-testid="add-agent-button"
    >
      <CardContent className="p-4 relative">
        {/* Empty space for toggle alignment */}
        <div className="absolute top-3 right-3">
          <div className="h-4 w-8"></div>
        </div>

        <div className="flex items-start gap-4 pr-10">
          {/* Icon placeholder matching avatar size */}
          <div className="h-16 w-16 flex-shrink-0 rounded-xl border-2 border-dashed border-muted-foreground/50 flex items-center justify-center bg-muted/20">
            <Plus className="h-6 w-6 text-muted-foreground" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-xl mb-1 text-muted-foreground">Create New Agent</h3>
            <p className="text-sm text-muted-foreground/70 line-clamp-2 leading-relaxed">
              Add a new AI agent to your <br></br> collection
            </p>
          </div>
        </div>

        <Separator className="my-3" />

        <div className="flex items-center justify-end">
          {/* Create button styled like New Chat */}
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleClick();
            }}
            className="h-8 px-4 rounded-sm bg-background border-muted-foreground/20 hover:bg-muted/30"
          >
            <Plus className="h-4 w-4 mr-2" />
            Create
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default AddAgentCard;
