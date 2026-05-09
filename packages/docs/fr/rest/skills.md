---
title: "API Skills"
sidebarTitle: "Skills"
description: "Points de terminaison de l'API REST pour la gestion des skills locaux, le catalogue de skills et la marketplace de skills."
---

L'API skills couvre trois domaines : **les skills locaux** (fichiers d'action TypeScript spécifiques à l'agent), le **catalogue de skills** (registre organisé de skills communautaires) et la **marketplace de skills** (paquets de skills basés sur npm). Les skills étendent l'agent avec de nouvelles actions, fournisseurs ou évaluateurs.

Lorsque `ELIZA_API_TOKEN` est défini, incluez-le comme jeton `Bearer` dans l'en-tête `Authorization`.

<div id="endpoints">

## Points de terminaison

</div>

<div id="local-skills">

### Skills locaux

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/skills` | Lister tous les skills locaux avec leurs métadonnées |
| POST | `/api/skills/refresh` | Re-scanner le répertoire des skills |
| GET | `/api/skills/:id/scan` | Scanner un fichier de skill et retourner les métadonnées analysées |
| POST | `/api/skills/create` | Créer un nouveau fichier de skill à partir d'un modèle |
| POST | `/api/skills/:id/open` | Ouvrir un fichier de skill dans l'éditeur par défaut |
| GET | `/api/skills/:id/source` | Lire le code source d'un skill |
| PUT | `/api/skills/:id/source` | Écrire le code source mis à jour d'un skill |
| POST | `/api/skills/:id/enable` | Activer un skill (respecte les acquittements de scan) |
| POST | `/api/skills/:id/disable` | Désactiver un skill |

<div id="skills-catalog">

### Catalogue de skills

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/skills/catalog` | Lister le catalogue de skills avec pagination |
| GET | `/api/skills/catalog/search` | Rechercher dans le catalogue par requête |
| GET | `/api/skills/catalog/:id` | Obtenir les détails d'une entrée du catalogue |
| POST | `/api/skills/catalog/refresh` | Rafraîchir le catalogue depuis le registre distant |
| POST | `/api/skills/catalog/install` | Installer un skill du catalogue |
| POST | `/api/skills/catalog/uninstall` | Désinstaller un skill du catalogue |

<div id="skills-marketplace">

### Marketplace de skills

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/skills/marketplace/search` | Rechercher dans la marketplace npm pour les skills |
| GET | `/api/skills/marketplace/installed` | Lister les skills de la marketplace installés |
| POST | `/api/skills/marketplace/install` | Installer un skill depuis npm |
| POST | `/api/skills/marketplace/uninstall` | Désinstaller un skill de la marketplace |
| GET | `/api/skills/marketplace/config` | Obtenir la configuration de la marketplace |
| PUT | `/api/skills/marketplace/config` | Mettre à jour la configuration de la marketplace |

---

<div id="local-skills-1">

## Skills locaux

</div>

<div id="get-apiskills">

### GET /api/skills

</div>

Lister tous les skills locaux trouvés dans le répertoire de skills de l'agent. Chaque entrée inclut le chemin du fichier, les métadonnées d'action analysées et les préférences d'activation/priorité.

**Réponse**

```json
{
  "skills": [
    {
      "id": "my-custom-action",
      "name": "MY_CUSTOM_ACTION",
      "description": "Does something useful",
      "filePath": "/path/to/skills/my-custom-action.ts",
      "enabled": true,
      "priority": 0,
      "valid": true
    }
  ]
}
```

---

<div id="post-apiskillsrefresh">

### POST /api/skills/refresh

</div>

Re-scanner le répertoire des skills et recharger toutes les métadonnées des skills. Utile après avoir ajouté ou modifié manuellement des fichiers de skills.

**Réponse**

```json
{
  "ok": true,
  "count": 5
}
```

---

<div id="get-apiskillsidscan">

### GET /api/skills/:id/scan

</div>

Scanner un fichier de skill unique et retourner ses métadonnées AST analysées — actions, fournisseurs et évaluateurs exportés.

**Réponse**

```json
{
  "id": "my-skill",
  "actions": [
    {
      "name": "MY_ACTION",
      "description": "Action description",
      "similes": ["DO_THING"],
      "parameters": []
    }
  ],
  "providers": [],
  "evaluators": []
}
```

---

<div id="post-apiskillscreate">

### POST /api/skills/create

</div>

Créer un nouveau fichier de skill à partir d'un modèle intégré.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | string | Oui | Nom du fichier de skill (par ex. `my-action`) |
| `template` | string | Non | Modèle à utiliser — par défaut un modèle d'action basique |

**Réponse**

```json
{
  "ok": true,
  "skill": {
    "id": "my-action",
    "filePath": "/path/to/skills/my-action.ts"
  }
}
```

---

<div id="post-apiskillsidopen">

### POST /api/skills/:id/open

</div>

Ouvrir le fichier de skill dans l'éditeur de code par défaut du système.

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="get-apiskillsidsource">

### GET /api/skills/:id/source

</div>

Lire le code source TypeScript brut d'un fichier de skill.

**Réponse**

```json
{
  "id": "my-skill",
  "source": "import { Action } from '@elizaos/core';\n\nexport const myAction: Action = { ... };"
}
```

---

<div id="put-apiskillsidsource">

### PUT /api/skills/:id/source

</div>

Écrire le code source mis à jour dans un fichier de skill. Le serveur valide la syntaxe de base avant l'enregistrement.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `source` | string | Oui | Le nouveau code source TypeScript |

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillsidenable">

### POST /api/skills/:id/enable

</div>

Activer un skill installé. Retourne 409 si le skill a des résultats de scan non acquittés — acquittez via `POST /api/skills/:id/acknowledge` d'abord.

**Réponse**

```json
{
  "ok": true,
  "skill": {
    "id": "my-skill",
    "enabled": true
  },
  "scanStatus": null
}
```

---

<div id="post-apiskillsiddisable">

### POST /api/skills/:id/disable

</div>

Désactiver un skill installé.

**Réponse**

```json
{
  "ok": true,
  "skill": {
    "id": "my-skill",
    "enabled": false
  },
  "scanStatus": null
}
```

---

<div id="skills-catalog-1">

## Catalogue de skills

</div>

<div id="get-apiskillscatalog">

### GET /api/skills/catalog

</div>

Parcourir le catalogue de skills organisé avec pagination et tri.

**Paramètres de requête**

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `page` | number | 1 | Numéro de page |
| `perPage` | number | 50 | Éléments par page (max 100) |
| `sort` | string | `downloads` | Champ de tri |

**Réponse**

```json
{
  "skills": [
    {
      "id": "greeting-skill",
      "name": "Greeting Skill",
      "description": "Custom greeting actions",
      "author": "community",
      "downloads": 1234,
      "installed": false
    }
  ],
  "total": 42,
  "page": 1,
  "perPage": 50
}
```

---

<div id="get-apiskillscatalogsearch">

### GET /api/skills/catalog/search

</div>

Rechercher dans le catalogue par requête textuelle.

**Paramètres de requête**

| Paramètre | Type | Description |
|-----------|------|-------------|
| `q` | string | Requête de recherche (requis) |
| `limit` | number | Résultats max (par défaut 30, max 100) |

**Réponse**

```json
{
  "skills": [ ... ],
  "total": 5
}
```

---

<div id="get-apiskillscatalogid">

### GET /api/skills/catalog/:id

</div>

Obtenir les détails complets d'une entrée de skill du catalogue.

**Réponse**

```json
{
  "skill": {
    "id": "greeting-skill",
    "name": "Greeting Skill",
    "description": "Full description...",
    "author": "community",
    "version": "1.0.0",
    "installed": false,
    "readme": "# Greeting Skill\n..."
  }
}
```

---

<div id="post-apiskillscatalogrefresh">

### POST /api/skills/catalog/refresh

</div>

Forcer le rafraîchissement du catalogue depuis le registre distant.

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillscataloginstall">

### POST /api/skills/catalog/install

</div>

Installer un skill depuis le catalogue.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `id` | string | Oui | ID du skill du catalogue |

**Réponse**

```json
{
  "ok": true,
  "skill": { "id": "greeting-skill", "installed": true }
}
```

---

<div id="post-apiskillscataloguninstall">

### POST /api/skills/catalog/uninstall

</div>

Désinstaller un skill du catalogue précédemment installé.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `id` | string | Oui | ID du skill du catalogue |

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="skills-marketplace-1">

## Marketplace de skills

</div>

<div id="get-apiskillsmarketplacesearch">

### GET /api/skills/marketplace/search

</div>

Rechercher dans la marketplace de skills basée sur npm.

**Paramètres de requête**

| Paramètre | Type | Description |
|-----------|------|-------------|
| `q` | string | Requête de recherche |
| `limit` | number | Résultats max (par défaut 30, max 100) |

**Réponse**

```json
{
  "results": [
    {
      "name": "@community/skill-weather",
      "description": "Weather lookup skill",
      "version": "2.1.0"
    }
  ]
}
```

---

<div id="get-apiskillsmarketplaceinstalled">

### GET /api/skills/marketplace/installed

</div>

Lister tous les skills de la marketplace actuellement installés.

**Réponse**

```json
{
  "skills": [
    {
      "name": "@community/skill-weather",
      "version": "2.1.0",
      "installedAt": "2025-06-01T12:00:00Z"
    }
  ]
}
```

---

<div id="post-apiskillsmarketplaceinstall">

### POST /api/skills/marketplace/install

</div>

Installer un paquet de skill depuis la marketplace npm.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | string | Oui | Nom du paquet npm |
| `version` | string | Non | Version spécifique (par défaut la dernière) |

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillsmarketplaceuninstall">

### POST /api/skills/marketplace/uninstall

</div>

Désinstaller un paquet de skill de la marketplace.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | string | Oui | Nom du paquet npm |

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="get-apiskillsmarketplaceconfig">

### GET /api/skills/marketplace/config

</div>

Obtenir la configuration actuelle de la marketplace.

**Réponse**

```json
{
  "config": { ... }
}
```

---

<div id="put-apiskillsmarketplaceconfig">

### PUT /api/skills/marketplace/config

</div>

Mettre à jour la configuration de la marketplace.

**Corps de la requête**

Objet de configuration arbitraire — varie selon le backend de la marketplace.

**Réponse**

```json
{
  "ok": true
}
```

<div id="acknowledge-skill-findings">

## Acquitter les résultats de scan d'un skill

</div>

```
POST /api/skills/:id/acknowledge
```

Acquitte les résultats de l'analyse de sécurité d'un skill. Requis avant que le skill puisse être activé. Permet optionnellement d'activer le skill dans la même requête.

**Paramètres de chemin :**

| Paramètre | Type | Description |
|-----------|------|-------------|
| `id` | string | Slug du skill |

**Corps de la requête :**
```json
{ "enable": true }
```

`enable` est optionnel — omettez-le ou définissez-le à `false` pour acquitter sans activer.

**Réponse — résultats présents :**
```json
{
  "ok": true,
  "skillId": "my-skill",
  "acknowledged": true,
  "enabled": true,
  "findingCount": 3
}
```

**Réponse — aucun résultat (scan propre) :**
```json
{
  "ok": true,
  "message": "No findings to acknowledge.",
  "acknowledged": true
}
```

**Erreurs :** `404` aucun rapport de scan trouvé ; `403` le statut du skill est `"blocked"` (ne peut pas être acquitté).

---

<div id="skills-catalog-and-marketplace-runbook">

## Guide opérationnel du catalogue et de la marketplace de skills

</div>

<div id="setup-checklist">

### Liste de vérification de la configuration

</div>

1. Confirmez que le répertoire des skills (`~/.eliza/workspace/skills/`) est lisible et accessible en écriture par le runtime.
2. Confirmez que l'accès au réseau/registre de la marketplace est disponible (par défaut : `https://clawhub.ai`). Vérifiez les variables d'environnement `SKILLS_REGISTRY`, `CLAWHUB_REGISTRY` ou `SKILLS_MARKETPLACE_URL`.
3. Confirmez que les prérequis de l'installateur de plugins (`bun` et `git`) sont présents dans le PATH du runtime.
4. Pour la marketplace SkillsMP héritée, définissez `SKILLSMP_API_KEY` dans l'environnement.
5. Vérifiez que le fichier du catalogue existe à l'un des chemins attendus (fourni avec `@elizaos/plugin-agent-skills`).

<div id="failure-modes">

### Modes de défaillance

</div>

**Recherche et catalogue :**

- La recherche retourne des résultats vides de manière inattendue :
  Vérifiez l'entrée de la requête, la disponibilité du registre en amont et la limitation de débit. La correspondance floue utilise le slug, le nom, le résumé et les tags — essayez des termes de recherche plus larges.
- Le cache du catalogue est obsolète :
  Le cache en mémoire expire après 10 minutes. Forcez le rafraîchissement avec `POST /api/skills/catalog/refresh` ou redémarrez l'agent.

**Installation et désinstallation :**

- L'installation échoue avec une erreur réseau :
  Vérifiez la validité du nom/version du paquet, les permissions de l'installateur et le réseau. L'installateur utilise le checkout partiel pour les installations basées sur git — confirmez que `git` est disponible.
- L'analyse de sécurité bloque l'installation (statut `blocked`) :
  L'analyse a détecté des fichiers binaires (`.exe`, `.dll`, `.so`), des échappements de liens symboliques ou un `SKILL.md` manquant. Le répertoire du skill est automatiquement supprimé.
- L'installation échoue avec "already installed" :
  Un enregistrement pour cet ID de skill existe déjà. Désinstallez d'abord avec `POST /api/skills/marketplace/uninstall`, puis réessayez.
- La désinstallation laisse un état obsolète :
  Rafraîchissez la liste des skills et vérifiez que le paquet est supprimé de `marketplace-installs.json`.

**Chargement des skills :**

- Le skill personnalisé n'apparaît pas dans `/api/skills` :
  Confirmez que le répertoire du skill contient un `SKILL.md` valide avec le frontmatter name/description. Exécutez `POST /api/skills/refresh` pour re-scanner.
- Le skill se charge mais est désactivé :
  Vérifiez la cascade d'activation/désactivation : les préférences de la base de données remplacent la configuration, `denyBundled` bloque inconditionnellement.

<div id="recovery-procedures">

### Procédures de récupération

</div>

1. **Installation de marketplace corrompue :** Supprimez `~/.eliza/workspace/skills/.marketplace/<skill-id>/` et retirez son entrée de `~/.eliza/workspace/skills/.cache/marketplace-installs.json`, puis réinstallez.
2. **Fichier du catalogue manquant :** Réinstallez ou mettez à jour `@elizaos/plugin-agent-skills` pour restaurer le catalogue intégré.
3. **Conflit de remplacement de skill :** Si un skill de l'espace de travail remplace de manière inattendue un skill intégré, renommez le répertoire du skill de l'espace de travail ou déplacez-le vers un autre emplacement.

<div id="verification-commands">

### Commandes de vérification

</div>

```bash
# Skill catalog and marketplace unit tests
bunx vitest run src/services/plugin-installer.test.ts src/services/skill-marketplace.test.ts src/services/skill-catalog-client.test.ts

# Skills marketplace API and services e2e
bunx vitest run --config test/vitest/e2e.config.ts test/skills-marketplace-api.e2e.test.ts test/skills-marketplace-services.e2e.test.ts

# API server e2e (includes skills routes)
bunx vitest run --config test/vitest/e2e.config.ts test/api-server.e2e.test.ts

bun run typecheck
```

<div id="common-error-codes">

## Codes d'erreur courants

</div>

| Statut | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Le corps de la requête est malformé ou des champs requis sont manquants |
| 401 | `UNAUTHORIZED` | Jeton d'authentification manquant ou invalide |
| 404 | `NOT_FOUND` | La ressource demandée n'existe pas |
| 500 | `SKILL_BLOCKED` | Le skill est bloqué en raison des résultats de l'analyse de sécurité |
| 500 | `SYNTAX_ERROR` | Le code source du skill contient des erreurs de syntaxe |
| 500 | `ALREADY_INSTALLED` | Le skill est déjà installé |
| 500 | `INTERNAL_ERROR` | Erreur serveur inattendue |
