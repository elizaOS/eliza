---
title: "Plugin DeepSeek"
sidebarTitle: "DeepSeek"
description: "Fournisseur de modèles DeepSeek pour Eliza — modèles DeepSeek-V3 et DeepSeek-R1 de raisonnement."
---

<Warning>
Ce plugin n'est pas encore disponible dans le registre des plugins Eliza. Pour utiliser les modèles DeepSeek, configurez-les via le [plugin OpenRouter](/plugin-registry/llm/openrouter) avec l'identifiant de modèle approprié.
</Warning>

Le plugin DeepSeek connecte les agents Eliza à l'API de DeepSeek, fournissant l'accès aux modèles DeepSeek-V3 (usage général) et DeepSeek-R1 (axé sur le raisonnement) à des prix compétitifs.

**Package:** `@elizaos/plugin-deepseek` (pas encore publié)

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-deepseek
```

<div id="auto-enable">

## Activation automatique

</div>

Le plugin s'active automatiquement lorsque `DEEPSEEK_API_KEY` est présent :

```bash
export DEEPSEEK_API_KEY=sk-...
```

<div id="configuration">

## Configuration

</div>

| Variable d'environnement | Requis | Description |
|--------------------------|--------|-------------|
| `DEEPSEEK_API_KEY` | Oui | Clé API DeepSeek depuis [platform.deepseek.com](https://platform.deepseek.com) |
| `DEEPSEEK_API_URL` | Non | URL de base personnalisée (par défaut : `https://api.deepseek.com`) |

<div id="elizajson-example">

### Exemple eliza.json

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "deepseek",
        "model": "deepseek-chat"
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
| `deepseek-chat` | 64k | Chat à usage général (DeepSeek-V3) |
| `deepseek-reasoner` | 64k | Raisonnement par chaîne de pensée (DeepSeek-R1) |

DeepSeek-V3 est un modèle à mélange d'experts avec 671B paramètres (37B actifs). DeepSeek-R1 est un modèle de raisonnement entraîné par apprentissage par renforcement.

<div id="model-type-mapping">

## Correspondance des types de modèle

</div>

| Type de modèle elizaOS | Modèle DeepSeek |
|------------------------|----------------|
| `TEXT_SMALL` | `deepseek-chat` |
| `TEXT_LARGE` | `deepseek-chat` ou `deepseek-reasoner` (configurez le slot large) |

<div id="features">

## Fonctionnalités

</div>

- Format d'API compatible avec OpenAI
- Réponses en streaming
- Appel de fonctions / utilisation d'outils
- Conversation multi-tours
- Génération de code (héritage de DeepSeek-Coder dans V3)
- Raisonnement par chaîne de pensée (R1)
- Tarification compétitive — nettement moins cher que les modèles occidentaux comparables

<div id="deepseek-r1-reasoning">

## Raisonnement DeepSeek-R1

</div>

Le modèle `deepseek-reasoner` produit un bloc `<think>` contenant sa chaîne de raisonnement avant la réponse finale. Configurez le slot de texte **large** sur `deepseek-reasoner`, puis utilisez `TEXT_LARGE` :

```typescript
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Prove that there are infinitely many prime numbers.",
});
```

<div id="local-deepseek-via-ollama">

## DeepSeek local via Ollama

</div>

Pour l'inférence locale, configurez le [plugin Ollama](/fr/plugin-registry/llm/ollama)
avec Eliza-1 au lieu de router DeepSeek via un serveur local.

<div id="rate-limits-and-pricing">

## Limites de débit et tarification

</div>

DeepSeek offre une tarification compétitive par token. Consultez [platform.deepseek.com/docs/pricing](https://platform.deepseek.com/docs/pricing) pour les tarifs actuels.

DeepSeek-V3 coûte une fraction de GPT-4o pour une qualité comparable sur la plupart des tâches.

<div id="related">

## Associé

</div>

- [Plugin OpenRouter](/fr/plugin-registry/llm/openrouter) — Accédez à DeepSeek via OpenRouter
- [Plugin Groq](/fr/plugin-registry/llm/groq) — Alternative d'inférence rapide
- [Plugin Ollama](/fr/plugin-registry/llm/ollama) — Exécutez DeepSeek localement
- [Fournisseurs de modèles](/fr/runtime/models) — Comparer tous les fournisseurs
