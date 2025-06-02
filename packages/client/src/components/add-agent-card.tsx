import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card'; // Assuming you have a Card component
import { PlusCircle } from 'lucide-react';

const AddAgentCard: React.FC = () => {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate('/create'); // Navigate to the agent creation page
  };

  return (
    <Card
      className="w-full h-full cursor-pointer hover:shadow-lg transition-shadow flex flex-col items-center justify-center min-h-[180px] border-2 border-dashed hover:border-primary"
      onClick={handleClick}
      onKeyPress={(e) => e.key === 'Enter' && handleClick()}
      tabIndex={0} // Make it focusable
      role="button"
      aria-label="Create new agent"
    >
      <CardContent className="p-6 flex flex-col items-center justify-center text-center">
        <PlusCircle className="w-12 h-12 text-muted-foreground mb-3" />
        <p className="text-sm font-medium text-muted-foreground">Create New Agent</p>
      </CardContent>
    </Card>
  );
};

export default AddAgentCard;
