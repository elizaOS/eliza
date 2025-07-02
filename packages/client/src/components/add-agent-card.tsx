import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Plus, Settings } from 'lucide-react';

const AddAgentCard: React.FC = () => {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate('/create');
  };

  return (
    <Card
      className="w-full cursor-pointer hover:shadow-lg transition-shadow border-2 border-dashed hover:border-primary"
      onClick={handleClick}
      onKeyPress={(e) => e.key === 'Enter' && handleClick()}
      tabIndex={0}
      role="button"
      aria-label="Create new agent"
      data-testid="add-agent-button"
    >
      <CardContent className="p-4">
        {/* Top section with placeholder avatar, name, description and empty toggle space */}
        <div className="flex items-start gap-3 mb-4">
          {/* Icon placeholder matching avatar size */}
          <div className="h-16 w-16 flex-shrink-0 rounded-lg border-2 border-dashed border-muted-foreground/50 flex items-center justify-center">
            <Plus className="h-8 w-8 text-muted-foreground" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg text-muted-foreground mb-2">Create New Agent</h3>

            {/* Description - Reserve space for 2 lines to match agent cards */}
            <div className="h-10 flex items-start">
              <p
                className="text-sm text-muted-foreground/70 leading-5 overflow-hidden"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                Add a new AI agent to your collection
              </p>
            </div>
          </div>

          {/* Empty space for toggle alignment */}
          <div className="flex-shrink-0 w-11 h-6"></div>
        </div>

        {/* Bottom section with placeholder buttons to match layout */}
        <div className="flex items-center justify-between">
          {/* Settings button placeholder */}
          <Button variant="ghost" size="sm" className="h-8 px-2 opacity-50 cursor-default" disabled>
            <Settings className="h-4 w-4" />
          </Button>

          {/* Create button styled like New Chat */}
          <Button
            variant="default"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleClick();
            }}
            className="h-8 px-3"
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
