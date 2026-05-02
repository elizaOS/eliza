/**
 * Relational Data benchmark test prompts
 */

import { TestPrompt } from "../types";

export const relationalDataPrompts: TestPrompt[] = [
  // Entity creation tests
  {
    id: "relational-create-person",
    category: "relational-data",
    prompt: "create a person named Alice",
    expectedPatterns: ["alice", "person", "created", "entity"],
    expectedActions: ["CREATE_ENTITY"],
  },
  {
    id: "relational-create-company",
    category: "relational-data",
    prompt: "create a company called TechCorp",
    expectedPatterns: ["techcorp", "company", "created", "entity"],
    expectedActions: ["CREATE_ENTITY"],
  },
  {
    id: "relational-create-product",
    category: "relational-data",
    prompt: "create a product named Laptop",
    expectedPatterns: ["laptop", "product", "created", "entity"],
    expectedActions: ["CREATE_ENTITY"],
  },
  {
    id: "relational-create-multiple",
    category: "relational-data",
    prompt: "create person Bob and person Carol",
    expectedPatterns: ["bob", "carol", "person", "created"],
    expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY"],
  },

  // Entity selection tests
  {
    id: "relational-select-entity",
    category: "relational-data",
    prompt: "select Alice",
    expectedPatterns: ["alice", "selected", "current entity"],
    expectedActions: ["SELECT_ENTITY"],
    setup: [
      {
        id: "relational-select-setup",
        category: "relational-data",
        prompt: "create person Alice",
        expectedPatterns: ["alice"],
        expectedActions: ["CREATE_ENTITY"],
      }
    ],
  },
  {
    id: "relational-select-by-type",
    category: "relational-data",
    prompt: "select the company TechCorp",
    expectedPatterns: ["techcorp", "selected", "company"],
    expectedActions: ["SELECT_ENTITY"],
    setup: [
      {
        id: "relational-select-company-setup",
        category: "relational-data",
        prompt: "create company TechCorp",
        expectedPatterns: ["techcorp"],
        expectedActions: ["CREATE_ENTITY"],
      }
    ],
  },

  // Attribute management tests
  {
    id: "relational-set-attribute-age",
    category: "relational-data",
    prompt: "set age to 30 for Alice",
    expectedPatterns: ["age", "30", "alice", "attribute"],
    expectedActions: ["SELECT_ENTITY", "SET_ATTRIBUTE"],
    setup: [
      {
        id: "relational-attribute-setup",
        category: "relational-data",
        prompt: "create person Alice",
        expectedPatterns: ["alice"],
        expectedActions: ["CREATE_ENTITY"],
      }
    ],
  },
  {
    id: "relational-set-attribute-role",
    category: "relational-data",
    prompt: "set role to manager",
    expectedPatterns: ["role", "manager", "attribute"],
    expectedActions: ["SET_ATTRIBUTE"],
    setup: [
      {
        id: "relational-role-setup-1",
        category: "relational-data",
        prompt: "create person John",
        expectedPatterns: ["john"],
        expectedActions: ["CREATE_ENTITY"],
      },
      {
        id: "relational-role-setup-2",
        category: "relational-data",
        prompt: "select John",
        expectedPatterns: ["john", "selected"],
        expectedActions: ["SELECT_ENTITY"],
      }
    ],
  },
  {
    id: "relational-set-multiple-attributes",
    category: "relational-data",
    prompt: "set department to engineering and salary to 100000",
    expectedPatterns: ["department", "engineering", "salary", "100000"],
    expectedActions: ["SET_ATTRIBUTE", "SET_ATTRIBUTE"],
    setup: [
      {
        id: "relational-multi-attr-setup",
        category: "relational-data",
        prompt: "create person Mike and select Mike",
        expectedPatterns: ["mike"],
        expectedActions: ["CREATE_ENTITY", "SELECT_ENTITY"],
      }
    ],
  },

  // Relationship creation tests
  {
    id: "relational-create-employment",
    category: "relational-data",
    prompt: "create employment relationship between Alice and TechCorp",
    expectedPatterns: ["employment", "alice", "techcorp", "relationship"],
    expectedActions: ["CREATE_RELATIONSHIP"],
    setup: [
      {
        id: "relational-emp-setup-1",
        category: "relational-data",
        prompt: "create person Alice",
        expectedPatterns: ["alice"],
        expectedActions: ["CREATE_ENTITY"],
      },
      {
        id: "relational-emp-setup-2",
        category: "relational-data",
        prompt: "create company TechCorp",
        expectedPatterns: ["techcorp"],
        expectedActions: ["CREATE_ENTITY"],
      }
    ],
  },
  {
    id: "relational-create-sibling",
    category: "relational-data",
    prompt: "make Bob and Carol siblings",
    expectedPatterns: ["sibling", "bob", "carol", "relationship"],
    expectedActions: ["CREATE_RELATIONSHIP"],
    setup: [
      {
        id: "relational-sibling-setup-1",
        category: "relational-data",
        prompt: "create person Bob",
        expectedPatterns: ["bob"],
        expectedActions: ["CREATE_ENTITY"],
      },
      {
        id: "relational-sibling-setup-2",
        category: "relational-data",
        prompt: "create person Carol",
        expectedPatterns: ["carol"],
        expectedActions: ["CREATE_ENTITY"],
      }
    ],
  },
  {
    id: "relational-create-ownership",
    category: "relational-data",
    prompt: "TechCorp owns Laptop",
    expectedPatterns: ["ownership", "techcorp", "laptop", "relationship"],
    expectedActions: ["CREATE_RELATIONSHIP"],
    setup: [
      {
        id: "relational-own-setup-1",
        category: "relational-data",
        prompt: "create company TechCorp",
        expectedPatterns: ["techcorp"],
        expectedActions: ["CREATE_ENTITY"],
      },
      {
        id: "relational-own-setup-2",
        category: "relational-data",
        prompt: "create product Laptop",
        expectedPatterns: ["laptop"],
        expectedActions: ["CREATE_ENTITY"],
      }
    ],
  },
  {
    id: "relational-create-parent-child",
    category: "relational-data",
    prompt: "create parent-child relationship with David as parent of Emma",
    expectedPatterns: ["parent", "child", "david", "emma", "relationship"],
    expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY", "CREATE_RELATIONSHIP"],
  },

  // Query operations tests
  {
    id: "relational-query-all-persons",
    category: "relational-data",
    prompt: "find all person entities",
    expectedPatterns: ["person", "entities", "found"],
    expectedActions: ["QUERY_ENTITIES"],
    setup: [
      {
        id: "relational-query-persons-setup",
        category: "relational-data",
        prompt: "create person Alice, person Bob, and company TechCorp",
        expectedPatterns: ["alice", "bob", "techcorp"],
        expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY"],
      }
    ],
  },
  {
    id: "relational-query-by-attribute",
    category: "relational-data",
    prompt: "find all entities with role manager",
    expectedPatterns: ["manager", "role", "found"],
    expectedActions: ["QUERY_ENTITIES"],
    setup: [
      {
        id: "relational-query-attr-setup-1",
        category: "relational-data",
        prompt: "create person Frank and set role to manager",
        expectedPatterns: ["frank", "manager"],
        expectedActions: ["CREATE_ENTITY", "SELECT_ENTITY", "SET_ATTRIBUTE"],
      },
      {
        id: "relational-query-attr-setup-2",
        category: "relational-data",
        prompt: "create person Grace and set role to developer",
        expectedPatterns: ["grace", "developer"],
        expectedActions: ["CREATE_ENTITY", "SELECT_ENTITY", "SET_ATTRIBUTE"],
      }
    ],
  },
  {
    id: "relational-query-relationships",
    category: "relational-data",
    prompt: "find all employment relationships",
    expectedPatterns: ["employment", "relationship", "found"],
    expectedActions: ["QUERY_RELATIONSHIPS"],
    setup: [
      {
        id: "relational-query-rel-setup",
        category: "relational-data",
        prompt: "create person Henry, company StartupCo, and employment between them",
        expectedPatterns: ["henry", "startupco", "employment"],
        expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY", "CREATE_RELATIONSHIP"],
      }
    ],
  },

  // Path finding tests
  {
    id: "relational-find-path-direct",
    category: "relational-data",
    prompt: "find path from Alice to TechCorp",
    expectedPatterns: ["path", "alice", "techcorp", "employment"],
    expectedActions: ["FIND_PATH"],
    setup: [
      {
        id: "relational-path-setup-1",
        category: "relational-data",
        prompt: "create person Alice and company TechCorp",
        expectedPatterns: ["alice", "techcorp"],
        expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY"],
      },
      {
        id: "relational-path-setup-2",
        category: "relational-data",
        prompt: "create employment between Alice and TechCorp",
        expectedPatterns: ["employment"],
        expectedActions: ["CREATE_RELATIONSHIP"],
      }
    ],
  },
  {
    id: "relational-find-path-indirect",
    category: "relational-data",
    prompt: "find path from Ian to Kate",
    expectedPatterns: ["path", "ian", "kate"],
    expectedActions: ["FIND_PATH"],
    setup: [
      {
        id: "relational-indirect-setup-1",
        category: "relational-data",
        prompt: "create person Ian, person Jack, and person Kate",
        expectedPatterns: ["ian", "jack", "kate"],
        expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY"],
      },
      {
        id: "relational-indirect-setup-2",
        category: "relational-data",
        prompt: "make Ian and Jack friends, make Jack and Kate siblings",
        expectedPatterns: ["friend", "sibling"],
        expectedActions: ["CREATE_RELATIONSHIP", "CREATE_RELATIONSHIP"],
      }
    ],
  },

  // Statistics tests
  {
    id: "relational-count-stats",
    category: "relational-data",
    prompt: "show graph statistics",
    expectedPatterns: ["entities", "relationships", "count", "statistics"],
    expectedActions: ["COUNT_STATISTICS"],
    setup: [
      {
        id: "relational-stats-setup",
        category: "relational-data",
        prompt: "create 3 persons and 2 companies with relationships",
        expectedPatterns: ["person", "company"],
        expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY"],
      }
    ],
  },

  // Delete operations tests
  {
    id: "relational-delete-entity",
    category: "relational-data",
    prompt: "delete entity Laura",
    expectedPatterns: ["delete", "laura", "removed"],
    expectedActions: ["DELETE_ENTITY"],
    setup: [
      {
        id: "relational-delete-setup",
        category: "relational-data",
        prompt: "create person Laura",
        expectedPatterns: ["laura"],
        expectedActions: ["CREATE_ENTITY"],
      }
    ],
  },
  {
    id: "relational-delete-with-relationships",
    category: "relational-data",
    prompt: "delete Mark and all his relationships",
    expectedPatterns: ["delete", "mark", "relationships", "removed"],
    expectedActions: ["DELETE_ENTITY"],
    setup: [
      {
        id: "relational-delete-rel-setup-1",
        category: "relational-data",
        prompt: "create person Mark and person Nancy",
        expectedPatterns: ["mark", "nancy"],
        expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY"],
      },
      {
        id: "relational-delete-rel-setup-2",
        category: "relational-data",
        prompt: "make Mark and Nancy friends",
        expectedPatterns: ["friend"],
        expectedActions: ["CREATE_RELATIONSHIP"],
      }
    ],
  },

  // Clear operations
  {
    id: "relational-clear-graph",
    category: "relational-data",
    prompt: "clear the entire graph",
    expectedPatterns: ["clear", "graph", "reset", "empty"],
    expectedActions: ["CLEAR_GRAPH"],
  },

  // Complex scenarios
  {
    id: "relational-complex-org-structure",
    category: "relational-data",
    prompt: "create an org with CEO Oliver managing Peter and Quinn",
    expectedPatterns: ["oliver", "peter", "quinn", "management", "ceo"],
    expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY", "SET_ATTRIBUTE", "CREATE_RELATIONSHIP", "CREATE_RELATIONSHIP"],
  },
  {
    id: "relational-complex-family-tree",
    category: "relational-data",
    prompt: "create family with parent Robert and children Sarah and Tom",
    expectedPatterns: ["robert", "sarah", "tom", "parent", "child"],
    expectedActions: ["CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY", "CREATE_RELATIONSHIP", "CREATE_RELATIONSHIP"],
  },
  {
    id: "relational-complex-product-ownership",
    category: "relational-data",
    prompt: "create company BigCorp that owns products Widget and Gadget, with Uma managing Widget",
    expectedPatterns: ["bigcorp", "widget", "gadget", "uma", "ownership", "management"],
    expectedActions: [
      "CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY", "CREATE_ENTITY",
      "CREATE_RELATIONSHIP", "CREATE_RELATIONSHIP", "CREATE_RELATIONSHIP"
    ],
    timeout: 10000,
  },

  // Edge cases
  {
    id: "relational-select-nonexistent",
    category: "relational-data",
    prompt: "select entity XYZ123",
    expectedPatterns: ["*not found*", "*does not exist*", "*no entity*"],
    expectedActions: [],
  },
  {
    id: "relational-invalid-relationship",
    category: "relational-data",
    prompt: "create telepathy relationship",
    expectedPatterns: ["*invalid*", "*unknown*", "*relationship type*"],
    expectedActions: [],
  },
  {
    id: "relational-empty-query",
    category: "relational-data",
    prompt: "query entities",
    expectedPatterns: ["*specify*", "*type*", "*what*"],
    expectedActions: [],
  },
];
