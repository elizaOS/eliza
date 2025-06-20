import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import AgentSettings from '@/components/agent-settings';
import { useAgent } from '@/hooks/use-query-hooks';
import { ArrowLeft } from 'lucide-react';
import { Loader2 } from 'lucide-react';

export default function AgentSettingsRoute() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const { data: agentData, isLoading } = useAgent(agentId!);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!agentData?.data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-muted-foreground">Agent not found</p>
        <Button onClick={() => navigate('/')}>Back to Home</Button>
      </div>
    );
  }

  const agent = agentData.data;

  return (
    <div className="flex w-full justify-center px-4 sm:px-6 overflow-y-auto">
      <div className="w-full md:max-w-4xl py-6">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')} className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold">Agent Settings</h1>
        </div>

        <div className="bg-background rounded-lg border p-6">
          <AgentSettings
            agent={agent}
            agentId={agentId!}
            onSaveComplete={() => {
              // After save, navigate back to home page
              navigate('/');
            }}
          />
        </div>
      </div>
    </div>
  );
}
