import React from 'react';
import { useElizaAgents } from '@/hooks/use-eliza';

const AgentList: React.FC = () => {
  const { agents, isLoading, error } = useElizaAgents();

  if (isLoading) return <div>Loading agents...</div>;
  if (error) return <div>Error loading agents: {(error as Error).message}</div>;

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Agents</h1>
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <div key={agent.id} className="border rounded-lg p-4 shadow-sm">
            <h2 className="text-xl font-semibold">{agent.name}</h2>
            <p className="text-sm text-gray-500">{agent.id}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AgentList;
