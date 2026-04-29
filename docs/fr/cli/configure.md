---
title: "milady configure"
sidebarTitle: "configure"
description: "Affiche des conseils de configuration et les variables d'environnement courantes."
---

Affiche une référence rapide de configuration dans le terminal. La commande `configure` est un guide informatif : elle montre comment lire les valeurs de configuration, quelles variables d'environnement définir pour les fournisseurs de modèles, et où modifier directement le fichier de configuration. Elle ne modifie aucun fichier ni paramètre.

<div id="usage">

## Utilisation

</div>

```bash
milady configure
```

<div id="options">

## Options

</div>

`milady configure` n'accepte aucune option au-delà des drapeaux globaux standard.

| Drapeau | Description |
|------|-------------|
| `-v, --version` | Affiche la version actuelle de Milady et quitte |
| `--help`, `-h` | Affiche l'aide pour cette commande |
| `--profile <name>` | Utilise un profil de configuration nommé (le répertoire d'état devient `~/.milady-<name>/`) |
| `--dev` | Raccourci pour `--profile dev` (définit également le port du gateway sur `19001`) |
| `--verbose` | Active les journaux informatifs d'exécution |
| `--debug` | Active les journaux d'exécution au niveau débogage |
| `--no-color` | Désactive les couleurs ANSI |

<div id="example">

## Exemple

</div>

```bash
milady configure
```

<div id="output">

## Sortie

</div>

L'exécution de `milady configure` affiche les informations suivantes dans le terminal :

```
Milady Configuration

Set values with:
  milady config get <key>     Read a config value
  Edit ~/.milady/milady.json directly for full control.

Common environment variables:
  ANTHROPIC_API_KEY    Anthropic (Claude)
  OPENAI_API_KEY       OpenAI (GPT)
  AI_GATEWAY_API_KEY   Vercel AI Gateway
  GOOGLE_API_KEY       Google (Gemini)
```

<div id="common-environment-variables">

## Variables d'environnement courantes

</div>

Les variables d'environnement suivantes configurent l'accès aux fournisseurs de modèles d'IA. Définissez-les dans votre profil shell (p. ex. `~/.zshrc` ou `~/.bashrc`), dans `~/.milady/.env`, ou dans un fichier `.env` dans votre répertoire de travail.

| Variable d'environnement | Fournisseur |
|---------------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway |
| `GOOGLE_API_KEY` | Google (Gemini) |
| `GROQ_API_KEY` | Groq |
| `XAI_API_KEY` | xAI (Grok) |
| `OPENROUTER_API_KEY` | OpenRouter |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `TOGETHER_API_KEY` | Together AI |
| `MISTRAL_API_KEY` | Mistral |
| `COHERE_API_KEY` | Cohere |
| `PERPLEXITY_API_KEY` | Perplexity |
| `OLLAMA_BASE_URL` | Ollama (local, pas de clé API) |

Pour une liste complète des fournisseurs pris en charge et de leurs variables d'environnement, consultez [milady models](/fr/cli/models) et [Variables d'environnement](/fr/cli/environment).

<div id="setting-configuration-values">

## Définir les valeurs de configuration

</div>

`milady configure` est en lecture seule. Pour modifier la configuration, utilisez l'une de ces approches :

**Lire une valeur :**
```bash
milady config get gateway.port
milady config get agents.defaults.workspace
```

**Inspecter toutes les valeurs :**
```bash
milady config show
milady config show --all      # inclure les champs avancés
milady config show --json     # sortie lisible par machine
```

**Trouver le fichier de configuration :**
```bash
milady config path
# Output: /Users/you/.milady/milady.json
```

**Modifier directement :**
```bash
# Ouvrir dans votre éditeur
$EDITOR ~/.milady/milady.json
```

<div id="related">

## Associé

</div>

- [milady config](/fr/cli/config) -- lire et inspecter les valeurs de configuration avec les sous-commandes `get`, `path` et `show`
- [milady models](/fr/cli/models) -- vérifier quels fournisseurs de modèles sont configurés
- [milady setup](/fr/cli/setup) -- initialiser le fichier de configuration et l'espace de travail
- [Variables d'environnement](/fr/cli/environment) -- référence complète des variables d'environnement
- [Référence de configuration](/fr/configuration) -- schéma complet du fichier de configuration et tous les paramètres disponibles
