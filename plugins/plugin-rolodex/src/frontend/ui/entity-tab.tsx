import React from 'react';
import type { UUID, Entity, Relationship } from '@elizaos/core';
import { Users, UserCheck, UserX, Activity } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

// Use local UI components
import { Button } from './button';
import { EntityGraph } from './entity-graph';

// Local utility function
const cn = (...classes: (string | undefined | null | false)[]) => {
  return classes.filter(Boolean).join(' ');
};

const apiClient = {
  getEntities: async (agentId: UUID) => {
    const params = new URLSearchParams();
    params.append('agentId', agentId);
    
    const response = await fetch(`/api/entities?${params.toString()}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch entities: ${response.status} ${errorText}`);
    }
    return await response.json();
  },

  getRelationships: async (agentId: UUID) => {
    const params = new URLSearchParams();
    params.append('agentId', agentId);
    
    const response = await fetch(`/api/relationships?${params.toString()}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch relationships: ${response.status} ${errorText}`);
    }
    return await response.json();
  },
};

const useEntities = (agentId: UUID) => {
  return useQuery<Entity[], Error>({
    queryKey: ['agents', agentId, 'entities'],
    queryFn: async () => {
      const response = await apiClient.getEntities(agentId);
      return response.data || [];
    },
  });
};

const useRelationships = (agentId: UUID) => {
  return useQuery<Relationship[], Error>({
    queryKey: ['agents', agentId, 'relationships'],
    queryFn: async () => {
      const response = await apiClient.getRelationships(agentId);
      return response.data || [];
    },
  });
};

export function EntityTab({ agentId }: { agentId: UUID }) {
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
  const [filterTrust, setFilterTrust] = useState<'all' | 'trusted' | 'suspicious'>('all');

  const {
    data: entities = [],
    isLoading: entitiesLoading,
    error: entitiesError,
  } = useEntities(agentId);

  const {
    data: relationships = [],
    isLoading: relationshipsLoading,
    error: relationshipsError,
  } = useRelationships(agentId);

  const isLoading = entitiesLoading || relationshipsLoading;
  const error = entitiesError || relationshipsError;

  // Filter entities based on trust level
  const filteredEntities = entities.filter(entity => {
    if (filterTrust === 'all') return true;
    
    const trust = entity.metadata?.trustMetrics;
    if (!trust || typeof trust !== 'object') return false;
    
    const trustLevel = 'helpfulness' in trust && 'suspicionLevel' in trust
      ? (trust as any).helpfulness - (trust as any).suspicionLevel
      : 0;
    
    if (filterTrust === 'trusted') return trustLevel > 0.5;
    if (filterTrust === 'suspicious') return trustLevel < -0.5;
    return true;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Activity className="h-8 w-8 animate-spin mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">Loading entities...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-destructive">
          <UserX className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">Error loading entities</p>
          <p className="text-sm">{error.message}</p>
        </div>
      </div>
    );
  }

  const entityStats = {
    total: entities.length,
    trusted: entities.filter(e => {
      const trust = e.metadata?.trustMetrics;
      if (!trust || typeof trust !== 'object') return false;
      const level = 'helpfulness' in trust && 'suspicionLevel' in trust
        ? (trust as any).helpfulness - (trust as any).suspicionLevel
        : 0;
      return level > 0.5;
    }).length,
    suspicious: entities.filter(e => {
      const trust = e.metadata?.trustMetrics;
      if (!trust || typeof trust !== 'object') return false;
      const level = 'helpfulness' in trust && 'suspicionLevel' in trust
        ? (trust as any).helpfulness - (trust as any).suspicionLevel
        : 0;
      return level < -0.5;
    }).length,
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 border-b gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Entity Relationships</h2>
          <p className="text-xs text-muted-foreground">
            {entityStats.total} entities • {relationships.length} relationships
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={filterTrust === 'all' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterTrust('all')}
            className="flex-shrink-0"
          >
            <Users className="h-4 w-4 mr-2" />
            All ({entityStats.total})
          </Button>
          <Button
            variant={filterTrust === 'trusted' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterTrust('trusted')}
            className="flex-shrink-0"
          >
            <UserCheck className="h-4 w-4 mr-2" />
            Trusted ({entityStats.trusted})
          </Button>
          <Button
            variant={filterTrust === 'suspicious' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterTrust('suspicious')}
            className="flex-shrink-0"
          >
            <UserX className="h-4 w-4 mr-2" />
            Suspicious ({entityStats.suspicious})
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {filteredEntities.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">
                {filterTrust === 'all' 
                  ? 'No entities found'
                  : `No ${filterTrust} entities found`}
              </p>
              <p className="text-sm">
                {filterTrust === 'all'
                  ? 'Entities will appear here as they are mentioned in conversations'
                  : 'Try changing the filter to see other entities'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <div className={`flex-1 p-4 ${selectedEntity ? 'h-2/3' : ''}`}>
              <EntityGraph
                entities={filteredEntities}
                relationships={relationships}
                onNodeClick={setSelectedEntity}
                selectedEntityId={selectedEntity?.id}
              />
            </div>
            {selectedEntity && (
              <div className="h-1/3 border-t bg-card p-4 overflow-auto">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="font-medium text-lg">{selectedEntity.names[0]}</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedEntity(null)}
                    className="text-xs h-7 px-2"
                  >
                    Close
                  </Button>
                </div>
                
                <div className="text-sm text-muted-foreground space-y-2">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <div>
                      <span className="font-medium text-foreground">Entity ID:</span>
                      <p className="font-mono text-xs">{selectedEntity.id}</p>
                    </div>
                    
                    {selectedEntity.names.length > 1 && (
                      <div>
                        <span className="font-medium text-foreground">Also known as:</span>
                        <p className="text-xs">{selectedEntity.names.slice(1).join(', ')}</p>
                      </div>
                    )}
                  </div>

                  {(() => {
                    const platformIds = selectedEntity.metadata?.platformIdentities;
                    if (platformIds && Array.isArray(platformIds) && platformIds.length > 0) {
                      return (
                        <div>
                          <span className="font-medium text-foreground">Platform Identities:</span>
                          <div className="mt-1 space-y-1">
                            {platformIds.map((p: any, idx: number) => (
                              <div key={idx} className="flex items-center gap-2 text-xs">
                                <span className="px-2 py-0.5 bg-accent/20 rounded">
                                  {p.platform}
                                </span>
                                <span className="font-mono">{p.handle}</span>
                                {p.verified && (
                                  <span className="text-green-600 dark:text-green-400">✓</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  {(() => {
                    const trust = selectedEntity.metadata?.trustMetrics;
                    if (trust && typeof trust === 'object' && 
                        'helpfulness' in trust && 'suspicionLevel' in trust) {
                      const helpfulness = (trust as any).helpfulness;
                      const suspicionLevel = (trust as any).suspicionLevel;
                      const trustLevel = helpfulness - suspicionLevel;
                      
                      return (
                        <div>
                          <span className="font-medium text-foreground">Trust Metrics:</span>
                          <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
                            <div className="text-center p-2 bg-accent/10 rounded">
                              <div className="font-medium">Helpfulness</div>
                              <div>{helpfulness.toFixed(2)}</div>
                            </div>
                            <div className="text-center p-2 bg-accent/10 rounded">
                              <div className="font-medium">Suspicion</div>
                              <div>{suspicionLevel.toFixed(2)}</div>
                            </div>
                            <div className="text-center p-2 bg-accent/10 rounded">
                              <div className="font-medium">Overall</div>
                              <div className={cn(
                                trustLevel > 0.5 ? 'text-green-600 dark:text-green-400' :
                                trustLevel < -0.5 ? 'text-red-600 dark:text-red-400' :
                                'text-yellow-600 dark:text-yellow-400'
                              )}>
                                {trustLevel.toFixed(2)}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  {(() => {
                    const entityRelationships = relationships.filter(
                      r => r.sourceEntityId === selectedEntity.id || 
                           r.targetEntityId === selectedEntity.id
                    );
                    
                    if (entityRelationships.length > 0) {
                      return (
                        <div>
                          <span className="font-medium text-foreground">
                            Relationships ({entityRelationships.length}):
                          </span>
                          <div className="mt-1 space-y-1">
                            {entityRelationships.slice(0, 5).map((rel, idx) => {
                              const otherEntityId = rel.sourceEntityId === selectedEntity.id 
                                ? rel.targetEntityId 
                                : rel.sourceEntityId;
                              const otherEntity = entities.find(e => e.id === otherEntityId);
                              
                              const relType = rel.metadata?.relationshipType;
                              const hasRelType = relType && typeof relType === 'string';
                              
                              return (
                                <div key={idx} className="text-xs flex items-center gap-2">
                                  <span className="text-muted-foreground">↔</span>
                                  <span>{otherEntity?.names[0] || 'Unknown'}</span>
                                  {hasRelType ? (
                                    <span className="px-1.5 py-0.5 bg-accent/20 rounded text-[10px]">
                                      {relType}
                                    </span>
                                  ) : null}
                                </div>
                              );
                            })}
                            {entityRelationships.length > 5 && (
                              <div className="text-xs text-muted-foreground">
                                ... and {entityRelationships.length - 5} more
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
