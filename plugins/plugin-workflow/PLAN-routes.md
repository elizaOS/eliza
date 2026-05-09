# Plan: Routes API pour plugin-n8n-workflow

## Objectif

Exposer une API REST depuis le plugin pour que le frontend (visual workflow editor) puisse manipuler les workflows n8n de manière agnostique, en parallèle des actions agent existantes.

```
┌─────────────────────────────────────────────────────────────┐
│                      eliza-cloud-v2                          │
│                                                              │
│   Agent (Actions)          Frontend (Routes API)            │
│   ───────────────          ─────────────────────            │
│   CREATE_N8N_WORKFLOW  ←→  POST /workflows                  │
│   ACTIVATE_WORKFLOW    ←→  POST /workflows/:id/activate     │
│   DELETE_WORKFLOW      ←→  DELETE /workflows/:id            │
│   GET_EXECUTIONS       ←→  GET /executions                  │
│                                                              │
│                    ↓ Même logique ↓                         │
│              ┌─────────────────────────┐                    │
│              │   plugin-n8n-workflow   │                    │
│              │   (proxy intelligent)   │                    │
│              └───────────┬─────────────┘                    │
│                          ↓                                  │
│                    n8n Cloud API                            │
└─────────────────────────────────────────────────────────────┘
```

---

## Routes à implémenter

### 1. Workflows (Proxy → n8n)

| Route | Méthode | Source | Description |
|-------|---------|--------|-------------|
| `/workflows` | GET | n8n API | Liste des workflows |
| `/workflows` | POST | n8n API + validation locale | Créer (avec validation) |
| `/workflows/:id` | GET | n8n API | Détail d'un workflow |
| `/workflows/:id` | PUT | n8n API + validation locale | Modifier (avec validation) |
| `/workflows/:id` | DELETE | n8n API | Supprimer |
| `/workflows/:id/activate` | POST | n8n API | Activer |
| `/workflows/:id/deactivate` | POST | n8n API | Désactiver |

### 2. Validation (Local)

| Route | Méthode | Source | Description |
|-------|---------|--------|-------------|
| `/workflows/validate` | POST | Local | Validation complète |

**Body:**
```json
{
  "nodes": [...],
  "connections": {...}
}
```

**Response:**
```json
{
  "valid": true,
  "errors": [],
  "warnings": ["Node 'X' has no incoming connections"]
}
```

**Fonctions utilisées:**
- `validateWorkflow()` → errors
- `validateNodeParameters()` → warnings (params manquants)
- `validateNodeInputs()` → warnings (inputs manquants)

### 3. Catalogue de nodes (Local)

| Route | Méthode | Source | Description |
|-------|---------|--------|-------------|
| `/nodes` | GET | Local | Recherche de nodes |
| `/nodes/:type` | GET | Local | Définition d'un node |
| `/nodes/available` | GET | Local + credentials | Nodes filtrés par intégrations supportées |

**GET /nodes?q=gmail,email&limit=20**
```json
{
  "nodes": [
    {
      "name": "n8n-nodes-base.gmail",
      "displayName": "Gmail",
      "score": 15,
      "matchReason": "exact match: gmail"
    }
  ]
}
```

**GET /nodes/available** ← Le plus important pour le visual editor
```json
{
  "supported": [
    { "name": "n8n-nodes-base.gmail", "displayName": "Gmail", ... }
  ],
  "unsupported": [
    { "name": "n8n-nodes-base.slack", "displayName": "Slack", "missingCredential": "slackOAuth2Api" }
  ],
  "utility": [
    { "name": "n8n-nodes-base.if", "displayName": "IF", ... }
  ]
}
```

**Fonctions utilisées:**
- `searchNodes(keywords, limit)`
- `getNodeDefinition(type)`
- `filterNodesByIntegrationSupport(nodes, supportedCredTypes)`

### 4. Executions (Proxy → n8n)

| Route | Méthode | Source | Description |
|-------|---------|--------|-------------|
| `/executions` | GET | n8n API | Liste des exécutions |
| `/executions/:id` | GET | n8n API | Détail d'une exécution |
| `/executions/:id/retry` | POST | n8n API | Relancer |

### 5. Credentials/Intégrations (Local + Store)

| Route | Méthode | Source | Description |
|-------|---------|--------|-------------|
| `/integrations` | GET | Credential Store | Intégrations configurées pour l'utilisateur |
| `/integrations/:type/status` | GET | Credential Store | Statut d'une intégration |

**GET /integrations**
```json
{
  "configured": [
    { "type": "gmailOAuth2Api", "status": "connected" },
    { "type": "stripeApi", "status": "connected" }
  ],
  "available": [
    { "type": "slackOAuth2Api", "status": "not_connected", "authUrl": "/connect/slack" }
  ]
}
```

---

## Fonctions existantes à réutiliser

### workflow.ts
- [x] `validateWorkflow(workflow)` → `{ valid, errors, warnings }`
- [x] `validateNodeParameters(workflow)` → `string[]` (warnings)
- [x] `validateNodeInputs(workflow)` → `string[]` (warnings)
- [x] `positionNodes(workflow)` → workflow avec positions

### catalog.ts
- [x] `getNodeDefinition(typeName)` → `NodeDefinition | undefined`
- [x] `searchNodes(keywords[], limit)` → `NodeSearchResult[]`
- [x] `filterNodesByIntegrationSupport(nodes, supportedCredTypes)` → `{ remaining, removed }`

### credentialResolver.ts
- [x] `resolveCredentials(workflow, userId, ...)` → résolution complète
- [x] `extractRequiredCredentialTypes(workflow)` → `Set<string>`

### api.ts (N8nApiClient)
- [x] `listWorkflows()`
- [x] `createWorkflow(workflow)`
- [x] `updateWorkflow(id, workflow)`
- [x] `deleteWorkflow(id)`
- [x] `activateWorkflow(id)`
- [x] `deactivateWorkflow(id)`
- [x] `listExecutions(workflowId?)`
- [x] `getExecution(id)`

---

## Ce qui manque à créer

### 1. Fonction pour lister les credentials configurés d'un user

```typescript
// utils/credentials.ts ou nouveau fichier
export async function getUserSupportedCredentialTypes(
  userId: string,
  credStore: N8nCredentialStoreApi | null,
  credProvider: CredentialProvider | null
): Promise<Set<string>> {
  const supported = new Set<string>();

  // 1. Depuis le credential store (mappings existants)
  if (credStore) {
    const mappings = await credStore.listByUser(userId);
    for (const mapping of mappings) {
      supported.add(mapping.credType);
    }
  }

  // 2. Depuis le provider (si disponible)
  if (credProvider?.listConnected) {
    const connected = await credProvider.listConnected(userId);
    for (const credType of connected) {
      supported.add(credType);
    }
  }

  return supported;
}
```

**⚠️ Nécessite d'ajouter `listByUser(userId)` au credential store.**

### 2. Fichier de routes

```typescript
// src/routes/index.ts
import type { Route } from "@elizaos/core";

export const n8nRoutes: Route[] = [
  // ... toutes les routes
];
```

### 3. Export dans le plugin

```typescript
// src/index.ts
import { n8nRoutes } from "./routes";

export const n8nWorkflowPlugin: Plugin = {
  name: "n8n-workflow",
  // ... existing
  routes: n8nRoutes,  // ← Ajouter
};
```

---

## Prérequis côté cloud-v2

1. **Catch-all route** : `app/api/plugins/[...path]/route.ts`
2. **Plugin route registry** : collecte et dispatch les routes des plugins
3. **Modification agent-loader** : extraire `plugin.routes` en plus de `actions/providers`

---

## Ordre d'implémentation

### Phase 1 : Core (plugin)
1. [ ] Ajouter `listByUser()` au credential store
2. [ ] Créer `getUserSupportedCredentialTypes()`
3. [ ] Créer `src/routes/index.ts` avec toutes les routes
4. [ ] Exporter `routes` dans le plugin

### Phase 2 : Infrastructure (cloud-v2)
5. [ ] Créer `lib/eliza/plugin-route-registry.ts`
6. [ ] Modifier `agent-loader.ts` pour collecter les routes
7. [ ] Créer `app/api/plugins/[...path]/route.ts`

### Phase 3 : Test & Polish
8. [ ] Tests unitaires des routes
9. [ ] Documentation OpenAPI des routes plugin
10. [ ] Intégration frontend

---

## Estimation

- Plugin (Phase 1) : ~200 lignes de code
- Cloud-v2 (Phase 2) : ~150 lignes de code
- Total : ~350 lignes pour une API complète
