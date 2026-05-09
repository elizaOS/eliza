---
title: "Plugin Anthropic"
sidebarTitle: "Anthropic"
description: "Fournisseur de modèles Anthropic Claude pour Eliza — Claude Opus 4.7, Sonnet 4.6, Haiku 4.5 et prise en charge de la réflexion adaptative."
---

Le plugin Anthropic connecte les agents Eliza à l'API Claude d'Anthropic et expose les modèles actuels Claude Opus 4.7, Claude Sonnet 4.6 et Claude Haiku 4.5.

**Package:** `@elizaos/plugin-anthropic`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-anthropic
```

<div id="auto-enable">

## Activation automatique

</div>

Le plugin s'active automatiquement lorsque `ANTHROPIC_API_KEY` ou `CLAUDE_API_KEY` est présent :

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

<div id="configuration">

## Configuration

</div>

| Variable d'environnement | Requis | Description |
|--------------------------|--------|-------------|
| `ANTHROPIC_API_KEY` | Oui* | Clé API Anthropic depuis [console.anthropic.com](https://console.anthropic.com) |
| `CLAUDE_API_KEY` | Oui* | Alias pour `ANTHROPIC_API_KEY` |
| `ANTHROPIC_API_URL` | Non | URL de base personnalisée |

*`ANTHROPIC_API_KEY` ou `CLAUDE_API_KEY` est requis.

<div id="elizajson-example">

### Exemple eliza.json

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      }
    }
  }
}
```

<div id="supported-models">

## Modèles pris en charge

</div>

| Modèle | Contexte | Idéal pour |
|--------|----------|------------|
| `claude-opus-4-7` | 200k | Le modèle le plus capable pour le raisonnement complexe et les agents longue durée |
| `claude-sonnet-4-6` | 200k | Le modèle large par défaut pour le code, l'analyse et l'usage général |
| `claude-haiku-4-5-20251001` | 200k | Tâches rapides et légères |

<div id="model-type-mapping">

## Correspondance des types de modèle

</div>

| Type de modèle elizaOS | Modèle Anthropic |
|------------------------|-----------------|
| `TEXT_SMALL` | `claude-haiku-4-5-20251001` |
| `TEXT_LARGE` | `claude-sonnet-4-6` |

<div id="features">

## Fonctionnalités

</div>

- Réponses en streaming
- Utilisation d'outils (appel de fonctions)
- Vision (entrée image sur tous les modèles)
- Réflexion adaptative/étendue sur `claude-sonnet-4-6` et `claude-opus-4-7`
- Sortie JSON structurée via l'utilisation d'outils
- Fenêtre de contexte de 200k tokens sur tous les modèles
- Cache de prompt pour réduire les coûts sur le contexte répété

<div id="extended-thinking">

## Réflexion étendue

</div>

Claude Sonnet 4.6 et Claude Opus 4.7 prennent en charge les modes adaptatif/étendu d'Anthropic pour le raisonnement complexe et la planification en plusieurs étapes.

```typescript
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Design a database schema for a multi-tenant SaaS application.",
  thinking: { type: "enabled", budgetTokens: 10000 },
});
```

<div id="rate-limits-and-pricing">

## Limites de taux et tarification

</div>

Les limites dépendent de votre niveau d'usage Anthropic. Consultez [docs.anthropic.com/en/api/rate-limits](https://docs.anthropic.com/en/api/rate-limits) pour les limites actuelles.

Tarification : [anthropic.com/pricing](https://www.anthropic.com/pricing)

<div id="related">

## Liens connexes

</div>

- [Plugin OpenAI](/fr/plugin-registry/llm/openai) — GPT-4o et modèles de raisonnement
- [Plugin OpenRouter](/fr/plugin-registry/llm/openrouter) — Routage entre fournisseurs, y compris Anthropic
- [Fournisseurs de modèles](/fr/runtime/models) — Comparer tous les fournisseurs
