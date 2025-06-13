import AgentCreator from '@/components/agent-creator';

export default function AgentCreatorRoute() {
  return (
    <div className="min-h-screen w-full overflow-x-hidden">
      <div className="flex w-full justify-center px-4 sm:px-6">
        <div className="w-full max-w-4xl min-w-0">
          <AgentCreator />
        </div>
      </div>
    </div>
  );
}
