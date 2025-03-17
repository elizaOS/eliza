import React from 'react';
import { useParams } from 'react-router-dom';
import { useAgent } from '@/hooks/use-query-hooks';
import { UUID } from '@elizaos/core';

const AgentDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useAgent((id as UUID) || null);

  if (isLoading) return <div>Loading agent details...</div>;
  if (error) return <div>Error loading agent: {(error as Error).message}</div>;
  if (!data?.data) return <div>Agent not found</div>;

  const agent = data.data;

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">{agent.name}</h1>
      <div className="grid gap-4">
        <div className="border rounded-lg p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Agent Details</h2>
          <p className="text-sm text-gray-500">ID: {agent.id}</p>
          {/* Add more agent details here */}
        </div>
      </div>
    </div>
  );
};

export default AgentDetail;
