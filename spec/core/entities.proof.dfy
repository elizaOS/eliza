lemma VisibleComponentFilter(components: seq<EntityComponent>, messageAuthor: string, entityId: string, agentId: string, trusted: seq<string>)
  ensures visibleComponents(components, messageAuthor, entityId, agentId, trusted) == ProofLib.Filter((component: EntityComponent) => componentVisible(component, messageAuthor, entityId, agentId, trusted), components)
{
}

lemma lawVisibleComponentsRetainExactData_ensures(components: seq<EntityComponent>, messageAuthor: string, entityId: string, agentId: string, trusted: seq<string>)
  ensures (lawVisibleComponentsRetainExactData(components, messageAuthor, entityId, agentId, trusted) == true)
{
  VisibleComponentFilter(components, messageAuthor, entityId, agentId, trusted);
  ProofLib.FilterSubset((component: EntityComponent) => componentVisible(component, messageAuthor, entityId, agentId, trusted), components);
}
