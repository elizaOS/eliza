---
title: "Plugin OpenAI"
sidebarTitle: "OpenAI"
description: "Fournisseur de modèles OpenAI pour Eliza — GPT-4o, o1, o3, embeddings, génération d'images et voix."
---

Le plugin OpenAI connecte les agents Eliza à l'API d'OpenAI, fournissant l'accès à GPT-4o, aux familles de modèles de raisonnement o1/o3, à la génération d'images DALL-E et à la transcription vocale Whisper.

**Package:** `@elizaos/plugin-openai`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-openai
```

Ou ajoutez dans `eliza.json` :

```json
{
  "plugins": {
    "allow": ["openai"]
  }
}
```

<div id="auto-enable">

## Activation automatique

</div>

Le plugin s'active automatiquement lorsque `OPENAI_API_KEY` est présent dans l'environnement :

```bash
export OPENAI_API_KEY=sk-...
```

<div id="configuration">

## Configuration

</div>

| Variable d'environnement | Requis | Description |
|--------------------------|--------|-------------|
| `OPENAI_API_KEY` | Oui | Clé API OpenAI depuis [platform.openai.com](https://platform.openai.com) |
| `OPENAI_API_URL` | Non | URL de base personnalisée (pour Azure OpenAI ou APIs compatibles) |
| `OPENAI_ORG_ID` | Non | ID d'organisation pour le suivi de l'utilisation |
| `OPENAI_PROJECT_ID` | Non | ID de projet pour la gestion des quotas |

<div id="elizajson-example">

### Exemple eliza.json

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openai",
        "model": "gpt-4o"
      }
    }
  }
}
```

<div id="supported-models">

## Modèles pris en charge

</div>

<div id="text-generation">

### Génération de texte

</div>

| Modèle | Contexte | Idéal pour |
|--------|----------|------------|
| `gpt-5.5` | 1M | Dernier modèle phare |
| `gpt-5-mini` | 1M | Tâches rapides et économiques |
| `gpt-5.5-nano` | 1M | Ultra-rapide, coût minimal |
| `gpt-4o` | 128k | Raisonnement multimodal |
| `gpt-5-mini` | 128k | Tâches multimodales rapides |

<div id="reasoning-models">

### Modèles de raisonnement

</div>

| Modèle | Contexte | Idéal pour |
|--------|----------|------------|
| `o1` | 200k | Tâches de raisonnement approfondi |
| `o1-mini` | 128k | Raisonnement rapide |
| `o3` | 200k | Raisonnement de pointe |
| `o3-mini` | 200k | Raisonnement efficace |
| `o4-mini` | 200k | Dernier raisonnement efficace |

<div id="other-capabilities">

### Autres capacités

</div>

| Capacité | Modèle |
|----------|--------|
| Embeddings | `text-embedding-3-small`, `text-embedding-3-large` |
| Génération d'images | `dall-e-3`, `dall-e-2` |
| Voix vers texte | `whisper-1` |
| Texte vers voix | `tts-1`, `tts-1-hd` |
| Vision | `gpt-4o` (multimodal) |

<div id="model-type-mapping">

## Correspondance des types de modèle

</div>

| Type de modèle elizaOS | Modèle OpenAI |
|------------------------|--------------|
| `TEXT_SMALL` | `gpt-5-mini` |
| `TEXT_LARGE` | `gpt-4o` |
| `TEXT_EMBEDDING` | `text-embedding-3-small` |
| `IMAGE` | `dall-e-3` |
| `TRANSCRIPTION` | `whisper-1` |
| `TEXT_TO_SPEECH` | `tts-1` |

<div id="features">

## Fonctionnalités

</div>

- Réponses en streaming
- Appel de fonctions/outils
- Vision (entrée d'images avec `gpt-4o`)
- Sortie JSON structurée (`response_format: { type: "json_object" }`)
- Prise en charge de l'API par lots
- Suivi de l'utilisation des tokens

<div id="usage-example">

## Exemple d'utilisation

</div>

```typescript
// In a plugin or action handler:
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Explain quantum entanglement in simple terms.",
  maxTokens: 500,
  temperature: 0.7,
});
```

<div id="rate-limits-and-pricing">

## Limites de débit et tarification

</div>

Les limites de débit dépendent de votre niveau d'utilisation OpenAI. Consultez [platform.openai.com/docs/guides/rate-limits](https://platform.openai.com/docs/guides/rate-limits) pour les limites actuelles par niveau.

Tarification : [openai.com/pricing](https://openai.com/pricing)

<div id="related">

## Associé

</div>

- [Plugin Anthropic](/fr/plugin-registry/llm/anthropic) — Famille de modèles Claude
- [Plugin OpenRouter](/fr/plugin-registry/llm/openrouter) — Routage entre fournisseurs
- [Fournisseurs de modèles](/fr/runtime/models) — Comparer tous les fournisseurs
