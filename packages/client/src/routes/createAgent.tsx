import AgentCreator from '@/components/agent-creator';

export default function AgentCreatorRoute() {
  return (
    <div className="flex w-full justify-center">
      <div className="w-full md:max-w-4xl">
        <AgentCreator />
      </div>
    </div>
  );
}
