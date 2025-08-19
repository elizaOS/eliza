import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

// Entity structure for relational data
interface Entity {
  id: string;
  type: string;
  name: string;
  attributes: Record<string, any>;
  created: string;
}

// Relationship structure
interface Relationship {
  id: string;
  type: string;
  fromEntity: string;
  toEntity: string;
  properties: Record<string, any>;
  created: string;
}

// Helper to get or initialize relational data state
function getRelationalState(state: State | undefined): {
  entities: Record<string, Entity>;
  relationships: Record<string, Relationship>;
  currentEntity: string | null;
  queryResults: any[];
} {
  return {
    entities: state?.values?.entities || {},
    relationships: state?.values?.relationships || {},
    currentEntity: state?.values?.currentEntity || null,
    queryResults: state?.values?.queryResults || [],
  };
}

// Helper to generate unique IDs
function generateId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `${prefix}_${timestamp}_${random}`;
}

// Create Entity Action
const createEntityAction: Action = {
  name: "CREATE_ENTITY",
  similes: ["NEW_ENTITY", "ADD_ENTITY", "MAKE_ENTITY"],
  description: "Create a new entity with a type and name. Entities are the nodes in our relational graph.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    const content = message.content.text?.toLowerCase() || "";
    
    // Parse entity type and name from message
    let entityType = "generic";
    let entityName = "unnamed";
    
    // Common entity types
    if (content.includes("person")) entityType = "person";
    else if (content.includes("company")) entityType = "company";
    else if (content.includes("product")) entityType = "product";
    else if (content.includes("location")) entityType = "location";
    else if (content.includes("project")) entityType = "project";
    else if (content.includes("department")) entityType = "department";
    else if (content.includes("task")) entityType = "task";
    else if (content.includes("document")) entityType = "document";
    
    // Extract name (simple pattern matching)
    const nameMatch = content.match(/named?\s+["']?([^"']+)["']?/i) ||
                     content.match(/called\s+["']?([^"']+)["']?/i) ||
                     content.match(/:\s*["']?([^"']+)["']?/i);
    if (nameMatch) {
      entityName = nameMatch[1].trim();
    }
    
    const entityId = generateId("entity");
    const entity: Entity = {
      id: entityId,
      type: entityType,
      name: entityName,
      attributes: {},
      created: new Date().toISOString(),
    };
    
    relState.entities[entityId] = entity;
    relState.currentEntity = entityId;
    
    const text = `Created entity: ${entityName} (${entityType}) with ID: ${entityId}`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        entities: relState.entities,
        currentEntity: entityId,
        lastOperation: "create_entity",
      },
      data: {
        operation: "create_entity",
        entity,
        totalEntities: Object.keys(relState.entities).length,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "create person entity named John" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Created entity: John (person) with ID: entity_...",
          actions: ["CREATE_ENTITY"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Create Relationship Action
const createRelationshipAction: Action = {
  name: "CREATE_RELATIONSHIP",
  similes: ["LINK", "CONNECT", "RELATE"],
  description: "Create a relationship between two entities. Relationships are the edges in our relational graph.",
  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
    const relState = getRelationalState(state);
    return Object.keys(relState.entities).length >= 2;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    const entities = Object.values(relState.entities);
    
    if (entities.length < 2) {
      return {
        success: false,
        text: "Error: Need at least 2 entities to create a relationship",
        values: state?.values || {},
      };
    }
    
    const content = message.content.text?.toLowerCase() || "";
    
    // Parse relationship type
    let relationType = "related_to";
    if (content.includes("parent") || content.includes("child")) relationType = "parent_child";
    else if (content.includes("sibling")) relationType = "sibling";
    else if (content.includes("friend")) relationType = "friend";
    else if (content.includes("employee") || content.includes("works")) relationType = "employment";
    else if (content.includes("owns") || content.includes("owner")) relationType = "ownership";
    else if (content.includes("manages") || content.includes("reports")) relationType = "management";
    else if (content.includes("partner")) relationType = "partnership";
    else if (content.includes("member")) relationType = "membership";
    else if (content.includes("located")) relationType = "location";
    else if (content.includes("assigned")) relationType = "assignment";
    
    // Use the most recent two entities or current + previous
    let fromEntity: Entity;
    let toEntity: Entity;
    
    if (relState.currentEntity && relState.entities[relState.currentEntity]) {
      fromEntity = relState.entities[relState.currentEntity];
      // Find the most recent entity that isn't the current one
      toEntity = entities.filter(e => e.id !== relState.currentEntity)[entities.length - 2] || entities[0];
    } else {
      // Use the two most recent entities
      fromEntity = entities[entities.length - 1];
      toEntity = entities[entities.length - 2];
    }
    
    const relationshipId = generateId("rel");
    const relationship: Relationship = {
      id: relationshipId,
      type: relationType,
      fromEntity: fromEntity.id,
      toEntity: toEntity.id,
      properties: {},
      created: new Date().toISOString(),
    };
    
    relState.relationships[relationshipId] = relationship;
    
    const text = `Created ${relationType} relationship: ${fromEntity.name} → ${toEntity.name}`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        relationships: relState.relationships,
        lastOperation: "create_relationship",
      },
      data: {
        operation: "create_relationship",
        relationship,
        fromEntity: fromEntity.name,
        toEntity: toEntity.name,
        totalRelationships: Object.keys(relState.relationships).length,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "create parent relationship" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Created parent_child relationship: Entity1 → Entity2",
          actions: ["CREATE_RELATIONSHIP"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Set Attribute Action
const setAttributeAction: Action = {
  name: "SET_ATTRIBUTE",
  similes: ["ADD_ATTRIBUTE", "SET_PROPERTY", "UPDATE_ATTRIBUTE"],
  description: "Set an attribute on the current entity. Attributes store additional data on entities.",
  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
    const relState = getRelationalState(state);
    return relState.currentEntity !== null && relState.entities[relState.currentEntity] !== undefined;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    
    if (!relState.currentEntity || !relState.entities[relState.currentEntity]) {
      return {
        success: false,
        text: "Error: No current entity selected",
        values: state?.values || {},
      };
    }
    
    const entity = relState.entities[relState.currentEntity];
    const content = message.content.text || "";
    
    // Parse attribute key and value
    let key = "property";
    let value: any = "value";
    
    // Common attributes
    const ageMatch = content.match(/age[:\s]+(\d+)/i);
    const emailMatch = content.match(/email[:\s]+([^\s]+)/i);
    const phoneMatch = content.match(/phone[:\s]+([^\s]+)/i);
    const statusMatch = content.match(/status[:\s]+([^\s]+)/i);
    const roleMatch = content.match(/role[:\s]+([^\s]+)/i);
    const departmentMatch = content.match(/department[:\s]+([^\s]+)/i);
    const salaryMatch = content.match(/salary[:\s]+(\d+)/i);
    const locationMatch = content.match(/location[:\s]+([^\s]+)/i);
    
    if (ageMatch) {
      key = "age";
      value = parseInt(ageMatch[1]);
    } else if (emailMatch) {
      key = "email";
      value = emailMatch[1];
    } else if (phoneMatch) {
      key = "phone";
      value = phoneMatch[1];
    } else if (statusMatch) {
      key = "status";
      value = statusMatch[1];
    } else if (roleMatch) {
      key = "role";
      value = roleMatch[1];
    } else if (departmentMatch) {
      key = "department";
      value = departmentMatch[1];
    } else if (salaryMatch) {
      key = "salary";
      value = parseInt(salaryMatch[1]);
    } else if (locationMatch) {
      key = "location";
      value = locationMatch[1];
    } else {
      // Generic pattern: key:value or key=value
      const genericMatch = content.match(/(\w+)[:\s=]+([^\s]+)/i);
      if (genericMatch) {
        key = genericMatch[1];
        value = genericMatch[2];
        // Try to parse as number if possible
        const numValue = parseFloat(value);
        if (!isNaN(numValue)) value = numValue;
      }
    }
    
    entity.attributes[key] = value;
    
    const text = `Set attribute on ${entity.name}: ${key} = ${value}`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        entities: relState.entities,
        lastOperation: "set_attribute",
      },
      data: {
        operation: "set_attribute",
        entityId: entity.id,
        entityName: entity.name,
        attribute: { key, value },
        totalAttributes: Object.keys(entity.attributes).length,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "set age 25" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Set attribute on Entity: age = 25",
          actions: ["SET_ATTRIBUTE"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Query Relationships Action
const queryRelationshipsAction: Action = {
  name: "QUERY_RELATIONSHIPS",
  similes: ["FIND_RELATIONSHIPS", "GET_CONNECTIONS", "SHOW_LINKS"],
  description: "Query relationships of a specific type or for a specific entity.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    const content = message.content.text?.toLowerCase() || "";
    
    let results: any[] = [];
    let queryDescription = "";
    
    // Query by relationship type
    if (content.includes("parent")) {
      results = Object.values(relState.relationships)
        .filter(r => r.type === "parent_child")
        .map(r => ({
          type: r.type,
          from: relState.entities[r.fromEntity]?.name || r.fromEntity,
          to: relState.entities[r.toEntity]?.name || r.toEntity,
        }));
      queryDescription = "parent-child relationships";
    } else if (content.includes("sibling")) {
      results = Object.values(relState.relationships)
        .filter(r => r.type === "sibling")
        .map(r => ({
          type: r.type,
          from: relState.entities[r.fromEntity]?.name || r.fromEntity,
          to: relState.entities[r.toEntity]?.name || r.toEntity,
        }));
      queryDescription = "sibling relationships";
    } else if (content.includes("all")) {
      results = Object.values(relState.relationships)
        .map(r => ({
          type: r.type,
          from: relState.entities[r.fromEntity]?.name || r.fromEntity,
          to: relState.entities[r.toEntity]?.name || r.toEntity,
        }));
      queryDescription = "all relationships";
    } else if (relState.currentEntity) {
      // Query relationships for current entity
      results = Object.values(relState.relationships)
        .filter(r => r.fromEntity === relState.currentEntity || r.toEntity === relState.currentEntity)
        .map(r => ({
          type: r.type,
          from: relState.entities[r.fromEntity]?.name || r.fromEntity,
          to: relState.entities[r.toEntity]?.name || r.toEntity,
          direction: r.fromEntity === relState.currentEntity ? "outgoing" : "incoming",
        }));
      queryDescription = `relationships for ${relState.entities[relState.currentEntity]?.name}`;
    }
    
    const text = `Found ${results.length} ${queryDescription}`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        queryResults: results,
        lastOperation: "query_relationships",
      },
      data: {
        operation: "query_relationships",
        query: queryDescription,
        results,
        count: results.length,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "query parent relationships" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Found 0 parent-child relationships",
          actions: ["QUERY_RELATIONSHIPS"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Query Entities Action
const queryEntitiesAction: Action = {
  name: "QUERY_ENTITIES",
  similes: ["FIND_ENTITIES", "SEARCH_ENTITIES", "LIST_ENTITIES"],
  description: "Query entities by type or attribute values.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    const content = message.content.text?.toLowerCase() || "";
    
    let results: Entity[] = [];
    let queryDescription = "";
    
    // Query by entity type
    if (content.includes("person")) {
      results = Object.values(relState.entities).filter(e => e.type === "person");
      queryDescription = "person entities";
    } else if (content.includes("company")) {
      results = Object.values(relState.entities).filter(e => e.type === "company");
      queryDescription = "company entities";
    } else if (content.includes("product")) {
      results = Object.values(relState.entities).filter(e => e.type === "product");
      queryDescription = "product entities";
    } else if (content.includes("all")) {
      results = Object.values(relState.entities);
      queryDescription = "all entities";
    } else {
      // Query by attribute
      const ageMatch = content.match(/age\s*[><=]+\s*(\d+)/);
      if (ageMatch) {
        const age = parseInt(ageMatch[1]);
        results = Object.values(relState.entities).filter(e => {
          const entityAge = e.attributes.age;
          if (typeof entityAge !== "number") return false;
          if (content.includes(">")) return entityAge > age;
          if (content.includes("<")) return entityAge < age;
          return entityAge === age;
        });
        queryDescription = `entities with age ${ageMatch[0]}`;
      } else {
        // Default to all entities
        results = Object.values(relState.entities);
        queryDescription = "all entities";
      }
    }
    
    const resultSummary = results.map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      attributes: e.attributes,
    }));
    
    const text = `Found ${results.length} ${queryDescription}`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        queryResults: resultSummary,
        lastOperation: "query_entities",
      },
      data: {
        operation: "query_entities",
        query: queryDescription,
        results: resultSummary,
        count: results.length,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "query person entities" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Found 0 person entities",
          actions: ["QUERY_ENTITIES"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Select Entity Action
const selectEntityAction: Action = {
  name: "SELECT_ENTITY",
  similes: ["CHOOSE_ENTITY", "FOCUS_ENTITY", "SET_CURRENT_ENTITY"],
  description: "Select an entity as the current entity for operations.",
  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
    const relState = getRelationalState(state);
    return Object.keys(relState.entities).length > 0;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    const content = message.content.text || "";
    
    if (Object.keys(relState.entities).length === 0) {
      return {
        success: false,
        text: "Error: No entities exist to select",
        values: state?.values || {},
      };
    }
    
    // Try to find entity by name
    let selectedEntity: Entity | undefined;
    
    for (const entity of Object.values(relState.entities)) {
      if (content.toLowerCase().includes(entity.name.toLowerCase())) {
        selectedEntity = entity;
        break;
      }
    }
    
    // If no match by name, select the most recent entity
    if (!selectedEntity) {
      const entities = Object.values(relState.entities);
      selectedEntity = entities[entities.length - 1];
    }
    
    relState.currentEntity = selectedEntity.id;
    
    const text = `Selected entity: ${selectedEntity.name} (${selectedEntity.type})`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        currentEntity: selectedEntity.id,
        lastOperation: "select_entity",
      },
      data: {
        operation: "select_entity",
        entity: selectedEntity,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "select entity John" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Selected entity: John (person)",
          actions: ["SELECT_ENTITY"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Delete Entity Action
const deleteEntityAction: Action = {
  name: "DELETE_ENTITY",
  similes: ["REMOVE_ENTITY", "DESTROY_ENTITY"],
  description: "Delete the current entity and all its relationships.",
  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
    const relState = getRelationalState(state);
    return relState.currentEntity !== null && relState.entities[relState.currentEntity] !== undefined;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    
    if (!relState.currentEntity || !relState.entities[relState.currentEntity]) {
      return {
        success: false,
        text: "Error: No current entity selected",
        values: state?.values || {},
      };
    }
    
    const entity = relState.entities[relState.currentEntity];
    const entityName = entity.name;
    
    // Delete the entity
    delete relState.entities[relState.currentEntity];
    
    // Delete all relationships involving this entity
    const relationshipsToDelete: string[] = [];
    for (const [relId, rel] of Object.entries(relState.relationships)) {
      if (rel.fromEntity === relState.currentEntity || rel.toEntity === relState.currentEntity) {
        relationshipsToDelete.push(relId);
      }
    }
    
    for (const relId of relationshipsToDelete) {
      delete relState.relationships[relId];
    }
    
    relState.currentEntity = null;
    
    const text = `Deleted entity: ${entityName} and ${relationshipsToDelete.length} relationships`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        entities: relState.entities,
        relationships: relState.relationships,
        currentEntity: null,
        lastOperation: "delete_entity",
      },
      data: {
        operation: "delete_entity",
        deletedEntity: entityName,
        deletedRelationships: relationshipsToDelete.length,
        remainingEntities: Object.keys(relState.entities).length,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "delete current entity" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Deleted entity: EntityName and 0 relationships",
          actions: ["DELETE_ENTITY"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Count Statistics Action
const countStatisticsAction: Action = {
  name: "COUNT_STATISTICS",
  similes: ["STATS", "STATISTICS", "COUNT"],
  description: "Get statistics about the current relational data graph.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    
    // Calculate statistics
    const totalEntities = Object.keys(relState.entities).length;
    const totalRelationships = Object.keys(relState.relationships).length;
    
    // Count entities by type
    const entityTypes: Record<string, number> = {};
    for (const entity of Object.values(relState.entities)) {
      entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
    }
    
    // Count relationships by type
    const relationshipTypes: Record<string, number> = {};
    for (const rel of Object.values(relState.relationships)) {
      relationshipTypes[rel.type] = (relationshipTypes[rel.type] || 0) + 1;
    }
    
    // Count total attributes
    let totalAttributes = 0;
    for (const entity of Object.values(relState.entities)) {
      totalAttributes += Object.keys(entity.attributes).length;
    }
    
    const stats = {
      totalEntities,
      totalRelationships,
      totalAttributes,
      entityTypes,
      relationshipTypes,
      currentEntity: relState.currentEntity ? relState.entities[relState.currentEntity]?.name : "none",
    };
    
    const text = `Graph statistics: ${totalEntities} entities, ${totalRelationships} relationships, ${totalAttributes} attributes`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        queryResults: [stats],
        lastOperation: "count_statistics",
      },
      data: {
        operation: "count_statistics",
        statistics: stats,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "show statistics" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Graph statistics: 0 entities, 0 relationships, 0 attributes",
          actions: ["COUNT_STATISTICS"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Clear Graph Action
const clearGraphAction: Action = {
  name: "CLEAR_GRAPH",
  similes: ["RESET_GRAPH", "CLEAR_ALL", "DELETE_ALL"],
  description: "Clear all entities and relationships from the graph.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = "Cleared all entities and relationships";
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        entities: {},
        relationships: {},
        currentEntity: null,
        queryResults: [],
        lastOperation: "clear_graph",
      },
      data: {
        operation: "clear_graph",
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "clear graph" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Cleared all entities and relationships",
          actions: ["CLEAR_GRAPH"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Find Path Action - finds shortest path between two entities
const findPathAction: Action = {
  name: "FIND_PATH",
  similes: ["PATH", "ROUTE", "CONNECTION_PATH"],
  description: "Find the shortest path between two entities in the relationship graph.",
  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
    const relState = getRelationalState(state);
    return Object.keys(relState.entities).length >= 2;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const relState = getRelationalState(state);
    
    if (Object.keys(relState.entities).length < 2) {
      return {
        success: false,
        text: "Error: Need at least 2 entities to find a path",
        values: state?.values || {},
      };
    }
    
    // Simple BFS path finding
    const entities = Object.values(relState.entities);
    const start = entities[0];
    const end = entities[entities.length - 1];
    
    // Build adjacency list
    const adjacency: Record<string, Set<string>> = {};
    for (const entity of entities) {
      adjacency[entity.id] = new Set();
    }
    
    for (const rel of Object.values(relState.relationships)) {
      adjacency[rel.fromEntity]?.add(rel.toEntity);
      adjacency[rel.toEntity]?.add(rel.fromEntity); // Treat as undirected for path finding
    }
    
    // BFS to find shortest path
    const queue: Array<{ node: string; path: string[] }> = [{ node: start.id, path: [start.id] }];
    const visited = new Set<string>();
    let foundPath: string[] = [];
    
    while (queue.length > 0) {
      const current = queue.shift()!;
      
      if (current.node === end.id) {
        foundPath = current.path;
        break;
      }
      
      if (visited.has(current.node)) continue;
      visited.add(current.node);
      
      for (const neighbor of adjacency[current.node] || []) {
        if (!visited.has(neighbor)) {
          queue.push({
            node: neighbor,
            path: [...current.path, neighbor],
          });
        }
      }
    }
    
    const pathNames = foundPath.map(id => relState.entities[id]?.name || id);
    const text = foundPath.length > 0
      ? `Found path: ${pathNames.join(" → ")}`
      : `No path found between ${start.name} and ${end.name}`;
    
    if (callback) {
      await callback({ text, source: message.content.source });
    }

    return {
      success: true,
      text,
      values: {
        ...state?.values,
        queryResults: [{ path: pathNames, length: foundPath.length }],
        lastOperation: "find_path",
      },
      data: {
        operation: "find_path",
        from: start.name,
        to: end.name,
        path: pathNames,
        pathLength: foundPath.length,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "find path between entities" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Found path: Entity1 → Entity2",
          actions: ["FIND_PATH"],
        },
      },
    ],
  ] as ActionExample[][],
};

// Export all relational data actions
export const relationalDataActions: Action[] = [
  createEntityAction,
  createRelationshipAction,
  setAttributeAction,
  queryRelationshipsAction,
  queryEntitiesAction,
  selectEntityAction,
  deleteEntityAction,
  countStatisticsAction,
  clearGraphAction,
  findPathAction,
];
