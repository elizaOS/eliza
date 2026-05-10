---
title: "Plugin OpenRouter"
sidebarTitle: "OpenRouter"
description: "Passerelle multi-fournisseurs OpenRouter pour Eliza — accédez à plus de 200 modèles d'OpenAI, Anthropic, Google, Meta et d'autres via une seule API."
---

Le plugin OpenRouter connecte les agents Eliza à la passerelle d'inférence unifiée d'OpenRouter, fournissant l'accès à plus de 200 modèles de tous les principaux fournisseurs via une seule clé API et un seul point d'accès.

**Package:** `@elizaos/plugin-openrouter`

<div id="eliza-pinned-version-and-upstream-bundle-bug">

## Eliza : version épinglée et bug du bundle upstream

</div>

Dans le monorepo Eliza, **`@elizaos/plugin-openrouter` est épinglé à `2.0.0-alpha.13`** (version exacte dans le `package.json` racine, reflétée dans `bun.lock`).

**Pourquoi épingler**

- **`2.0.0-alpha.12` sur npm est une publication défectueuse :** les bundles ESM Node et navigateur sont **tronqués**. Ils ne contiennent que des helpers de configuration empaquetés ; l'**objet principal du plugin est absent**, mais le fichier **exporte** toujours `openrouterPlugin` et un alias par défaut. **Pourquoi l'exécution échoue :** Bun (et tout outillage strict) tente de charger ce fichier et échoue car ces liaisons ne sont **jamais déclarées** dans le module.
- **Pourquoi pas `^2.0.0-alpha.13` :** Les plages semver peuvent flotter jusqu'à des versions défectueuses, ce qui casse `bun install` / le rafraîchissement du lockfile pour tous ceux qui utilisent OpenRouter.
- **Pourquoi nous ne corrigeons pas cela dans `patch-deps.mjs` :** Contrairement à un *nom* d'export incorrect dans un fichier par ailleurs complet, ce tarball omet le **fragment d'implémentation entier**. Un remplacement de chaîne en postinstall ne peut pas inventer le plugin ; la correction sûre est d'**utiliser une version fonctionnelle**.

**Quand retirer l'épinglage**

Après qu'upstream publie une version corrigée, vérifiez que `dist/node/index.node.js` contient le plugin complet (des centaines de lignes, pas ~80) et que `bun build …/index.node.js --target=bun` réussit, puis mettez à jour et relâchez la plage si souhaité.

**Référence :** [Résolution des plugins — OpenRouter épinglé](/fr/plugin-resolution-and-node-path#pinned-elizaosplugin-openrouter).

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-openrouter
```

<div id="auto-enable">

## Activation automatique

</div>

Le plugin s'active automatiquement lorsque `OPENROUTER_API_KEY` est présent :

```bash
export OPENROUTER_API_KEY=sk-or-...
```

<div id="configuration">

## Configuration

</div>

| Variable d'environnement | Requis | Description |
|--------------------------|--------|-------------|
| `OPENROUTER_API_KEY` | Oui | Clé API OpenRouter depuis [openrouter.ai](https://openrouter.ai) |

<div id="elizajson-example">

### Exemple eliza.json

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.6"
      }
    }
  }
}
```

<div id="supported-models">

## Modèles pris en charge

</div>

OpenRouter fournit l'accès aux modèles de tous les principaux fournisseurs. Utilisez l'ID de modèle complet avec le préfixe du fournisseur :

<div id="openai-via-openrouter">

### OpenAI via OpenRouter

</div>

| ID du modèle | Description |
|--------------|-------------|
| `openai/gpt-4o` | GPT-4o multimodal |
| `openai/gpt-5-mini` | Rapide et efficace |
| `openai/o1` | Modèle de raisonnement |
| `openai/o3-mini` | Raisonnement rapide |

<div id="anthropic-via-openrouter">

### Anthropic via OpenRouter

</div>

| ID du modèle | Description |
|--------------|-------------|
| `anthropic/claude-opus-4.7` | Claude le plus performant |
| `anthropic/claude-sonnet-4.6` | Claude équilibré |
| `anthropic/claude-haiku-4.5` | Claude le plus rapide |

<div id="meta-via-openrouter">

### Meta via OpenRouter

</div>

| ID du modèle | Description |
|--------------|-------------|
| `openai/gpt-oss-120b` | GPT-OSS 120B |

<div id="google-via-openrouter">

### Google via OpenRouter

</div>

| ID du modèle | Description |
|--------------|-------------|
| `google/gemini-2.5-pro` | Gemini 2.5 Pro |
| `google/gemini-2.5-flash` | Gemini 2.5 Flash |

Parcourez tous les modèles sur [openrouter.ai/models](https://openrouter.ai/models).

<div id="model-type-mapping">

## Correspondance des types de modèle

</div>

| Type de modèle elizaOS | Modèle OpenRouter par défaut |
|------------------------|----------------------------|
| `TEXT_SMALL` | `anthropic/claude-haiku-4.5` |
| `TEXT_LARGE` | `anthropic/claude-sonnet-4.6` |

<div id="features">

## Fonctionnalités

</div>

- Une seule clé API pour plus de 200 modèles
- Basculement automatique vers des fournisseurs de secours lorsque le principal est indisponible
- Optimisation des coûts — routage vers le fournisseur le moins cher disponible
- Comparaison de modèles et tests A/B
- Tableau de bord d'analyse de l'utilisation
- Réponses en streaming
- Format d'API compatible avec OpenAI
- Modèles gratuits disponibles (niveau communautaire)

<div id="provider-routing">

## Routage des fournisseurs

</div>

OpenRouter prend en charge les préférences de routage par coût, latence ou débit :

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.6",
        "providerPreferences": {
          "order": ["Anthropic", "AWS Bedrock"],
          "allowFallbacks": true
        }
      }
    }
  }
}
```

<div id="free-models">

## Modèles gratuits

</div>

OpenRouter offre un accès gratuit à une sélection de modèles open-source (avec limite de débit) :

- `openai/gpt-oss-120b:free`
- `mistralai/mistral-7b-instruct:free`

<div id="rate-limits-and-pricing">

## Limites de débit et tarification

</div>

La tarification est par modèle et varie selon le fournisseur. OpenRouter facture les mêmes tarifs que le fournisseur sous-jacent plus une petite marge sur certains modèles.

Consultez [openrouter.ai/docs#limits](https://openrouter.ai/docs#limits) pour les détails sur les limites de débit.

<div id="related">

## Associé

</div>

- [Plugin OpenAI](/fr/plugin-registry/llm/openai) — Intégration directe avec OpenAI
- [Plugin Anthropic](/fr/plugin-registry/llm/anthropic) — Intégration directe avec Anthropic
- [Fournisseurs de modèles](/fr/runtime/models) — Comparer tous les fournisseurs
