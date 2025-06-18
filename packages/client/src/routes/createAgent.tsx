import AgentCreator from '@/components/agent-creator';

export default function AgentCreatorRoute() {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="min-h-full flex w-full justify-center px-4 sm:px-6 py-4">
        <div className="w-full max-w-4xl min-w-0">
          <AgentCreator />
        </div>
      </div>
    </div>
  );
}
