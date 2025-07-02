import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Plus } from 'lucide-react';

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
      <CardContent className="p-4 relative">
        {/* Empty space for three-dot menu alignment */}
        <div className="absolute top-2 right-2">
          <div className="h-8 w-8"></div>
        </div>

        <div className="flex items-start gap-3 pr-8">
          {/* Icon placeholder matching avatar size */}
          <div className="h-12 w-12 flex-shrink-0 rounded-lg border-2 border-dashed border-muted-foreground/50 flex items-center justify-center">
            <Plus className="h-6 w-6 text-muted-foreground" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-base text-muted-foreground mb-1">Create New Agent</h3>

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
        </div>
      </CardContent>
    </Card>
  );
};

export default AddAgentCard;
