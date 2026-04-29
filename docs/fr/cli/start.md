---
title: "milady start"
sidebarTitle: "start"
description: "Démarrer le runtime de l'agent Milady en mode serveur uniquement."
---

Démarre le runtime de l'agent elizaOS en mode serveur headless. Le runtime démarre en mode `serverOnly`, ce qui signifie que le serveur API et la boucle de l'agent démarrent, mais aucune interface de chat interactive n'est lancée. La commande `run` est un alias direct de `start`.

<div id="usage">

## Utilisation

</div>

```bash
milady start
milady run     # alias pour start
```

<div id="options">

## Options

</div>

| Drapeau | Description |
|---------|-------------|
| `--connection-key [key]` | Définir ou générer automatiquement une clé de connexion pour l'accès distant. Passez une valeur pour utiliser une clé spécifique, ou passez le drapeau sans valeur pour en générer une automatiquement. La clé est définie comme `MILADY_API_TOKEN` pour la session. Lors d'une liaison à une adresse non-localhost (par ex., `MILADY_API_BIND=0.0.0.0`), une clé est générée automatiquement si aucune n'est configurée. |

Drapeaux globaux également applicables :

| Drapeau | Description |
|---------|-------------|
| `-v, --version` | Afficher la version actuelle de Milady et quitter |
| `--help`, `-h` | Afficher l'aide pour cette commande |
| `--profile <name>` | Utiliser un profil de configuration nommé (le répertoire d'état devient `~/.milady-<name>/`) |
| `--dev` | Raccourci pour `--profile dev` (définit également le port de la passerelle à `19001`) |
| `--verbose` | Activer les journaux d'exécution informatifs |
| `--debug` | Activer les journaux d'exécution au niveau débogage |
| `--no-color` | Désactiver les couleurs ANSI |

<div id="examples">

## Exemples

</div>

```bash
# Démarrer le runtime de l'agent en mode serveur
milady start

# Démarrer en utilisant l'alias run
milady run

# Démarrer avec un profil nommé (répertoire d'état isolé)
milady --profile production start

# Démarrer avec le profil dev
milady --dev start

# Démarrer avec une clé de connexion générée automatiquement (pour l'accès distant)
milady start --connection-key

# Démarrer avec une clé de connexion spécifique
milady start --connection-key my-secret-key
```

<div id="behavior">

## Comportement

</div>

Lorsque vous exécutez `milady start` :

1. Le CLI appelle `startEliza({ serverOnly: true })` depuis le runtime elizaOS.
2. En production (`milady start`), le serveur API démarre sur le port `2138` par défaut (modifiable avec `MILADY_PORT` ou `ELIZA_PORT`). En mode dev (`bun run dev`), l'API s'exécute sur le port `31337` (`MILADY_API_PORT`) tandis que l'interface du tableau de bord utilise `2138` (`MILADY_PORT`).
3. La boucle de l'agent commence à traiter les messages des clients connectés et des plateformes de messagerie.
4. Aucune interface interactive n'est lancée — le processus s'exécute en mode headless.

La commande `run` est un alias direct qui appelle exactement la même fonction `startEliza({ serverOnly: true })`.

<div id="environment-variables">

## Variables d'environnement

</div>

| Variable | Description | Par défaut |
|----------|-------------|------------|
| `MILADY_PORT` | Port du serveur API (accepte également `ELIZA_PORT` en repli) | `2138` |
| `MILADY_STATE_DIR` | Remplacement du répertoire d'état | `~/.milady/` |
| `MILADY_CONFIG_PATH` | Remplacement du chemin du fichier de configuration | `~/.milady/milady.json` |

<div id="deployment">

## Déploiement

</div>

`milady start` est le point d'entrée recommandé pour :

- Les déploiements en production
- Les conteneurs Docker
- Les environnements CI/CD
- Tout environnement headless ou serveur

Utilisez votre gestionnaire de processus préféré pour maintenir l'agent en fonctionnement :

```bash
# Avec pm2
pm2 start "milady start" --name milady

# Avec systemd (créer une unité de service)
ExecStart=/usr/local/bin/milady start

# Dans un Dockerfile
CMD ["milady", "start"]
```

Le serveur API prend en charge le redémarrage à chaud via `POST /api/agent/restart` lorsque `commands.restart` est activé dans la configuration.

<div id="related">

## Voir aussi

</div>

- [milady setup](/fr/cli/setup) — initialiser la configuration et l'espace de travail avant le démarrage
- [Variables d'environnement](/fr/cli/environment) — toutes les variables d'environnement
- [Configuration](/fr/configuration) — référence complète du fichier de configuration
