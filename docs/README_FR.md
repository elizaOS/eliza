# Eliza

<img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

_Utilisée dans [@DegenSpartanAI](https://x.com/degenspartanai) et [@MarcAIndreessen](https://x.com/pmairca)_

- Outil de simulation de multiples agents
- Ajout de multiples personnages avec [characterfile](https://github.com/lalalune/characterfile/)
- Support des fonctionnalités et connecteurs Discord/ Twitter / Telegram, avec salons vocaux sur Discord
- Accès aux données en mémoire et aux documents stockés
- Peut ouvrir et lire des documents PDF, retranscrire des fichiers son et vidéo, résumer des conversations, etc.
- Supporte les modèles open source et locaux (configuré par défaut avec Nous Hermes Llama 3.1B)
- Supporte OpenAI pour une utilisation sur le cloud depuis une machine peu performante
- Mode "Ask Claude" pour l'utilisation de Claude sur des modèles complexes
- 100% Typescript

# Premiers pas

**Pré-requis (obligatoire) :**

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 22+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

### Éditer le fichier .env

- Copiez le fichier .env.example, renommez-le en .env et remplissez les valeurs appropriées.
- Modifiez les variables d'environnement TWITTER pour ajouter le nom d'utilisateur et le mot de passe de votre bot.

### Modifier les fichiers personnage

1. Ouvrir le document `packages/core/src/defaultCharacter.ts` afin de modifier le personnage par défaut

2. Pour ajouter des personnages personnalisés :
    - Lancer la commande `pnpm start --characters="path/to/your/character.json"`
    - Plusieurs fichiers personnages peuvent être ajoutés en même temps

### Lancer Eliza

Après avoir terminé la configuration et les fichiers personnage, lancer le bot en tapant la ligne de commande suivante:

```bash
pnpm i
pnpm build
pnpm start

# Le projet étant régulièrement mis à jour, il vous faudra parfois le nettoyer avant de recommencer à travailler dessus
pnpm clean
```

# Personnaliser Eliza

### Ajouter une des actions personnalisées

Pour éviter les conflits Git dans le répertoire core, nous vous recommandons d’ajouter les actions personnalisées dans un répertoire `custom_actions` et de les configurer dans le fichier `elizaConfig.yaml` . Vous pouvez consulter l’exemple dans le fichier `elizaConfig.example.yaml`.

## Utiliser les différents modèles

### Lancer avec Llama

Vous pouvez exécuter le modèle Llama 70B ou 405B en définissant la variable d’environnement `XAI_MODEL` avec la valeur `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` ou `meta-llama/Meta-Llama-3.1-405B-Instruct`

### Lancer avec Grok

Vous pouvez exécuter le modèle Grok en définissant la variable d’environnement `XAI_MODEL` avec la valeur `grok-beta`

### Lancer avec OpenAI

Vous pouvez exécuter le modèle OpenAI en définissant la variable d’environnement `XAI_MODEL` avec la valeur `gpt-4o-mini` ou `gpt-4o`

## Ressources additionnelles

Il vous faudra peut-être installer Sharp.
Si il y a une erreur lors du lancement du bot, essayez d'installer Sharp comme ceci :

```
pnpm install --include=optional sharp
```

# Paramètres

Vous devez ajouter certaines variables à votre fichier .env pour vous connecter aux différentes plates-formes:

```
# Variables d'environnement Discord (nécessaires)
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # Bot token
OPENAI_API_KEY=sk-* # OpenAI API key, starting with sk-
ELEVENLABS_XI_API_KEY= # API key from elevenlabs

# Paramètres ELEVENLABS
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # Account username
TWITTER_PASSWORD= # Account password
TWITTER_EMAIL= # Account email

X_SERVER_URL=
XAI_API_KEY=
XAI_MODEL=


# Pour interagir avec Claude
ANTHROPIC_API_KEY=

WALLET_SECRET_KEY=EXAMPLE_WALLET_SECRET_KEY
WALLET_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

BIRDEYE_API_KEY=

SOL_ADDRESS=So11111111111111111111111111111111111111112
SLIPPAGE=1
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=


## Telegram
TELEGRAM_BOT_TOKEN=

TOGETHER_API_KEY=
```

# Utilisation en local

### Suite CUDA

Si vous avez une carte graphique NVIDIA, vous pouvez installer CUDA afin de grandement améliorer les performances :

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

Assurez-vous d’avoir le kit complet CUDA installé, y compris cuDNN et cuBLAS.

### Exécution locale

Ajoutez XAI_MODEL et définissez-le à l’une des options ci-dessus [Run with
Llama](#run-with-llama) - Vous pouvez laisser les valeurs X_SERVER_URL et XAI_API_KEY vides, le modèle sera téléchargé depuis huggingface et sera modifié en local

# Clients

## Bot Discord

Pour savoir comment configurer votre bot Discord, vous pouvez consulter la documentation officielle de Discord : https://discordjs.guide/preparations/setting-up-a-bot-application.html

# Développement

## Tests

Ligne de commande pour lancer les tests :

```bash
pnpm test          # Lance les tests
pnpm test:watch    # Lance les tests en mode observation
```

Pour les tests spécifiques à la base de données :

```bash
pnpm test:sqlite   # Lance les tests avec SQLite
pnpm test:sqljs    # Lance les tests avec SQL.js
```

Les tests sont écrits en Jest et se trouvent ici : `src/**/*.test.ts`. L’environnement de test est configuré pour :

- Charger les variables d’environnement depuis `.env.test`
- Ajouter un délai d'attente de 2 minutes pour les tests de longue durée
- Supporter les modules ESM
- Lancer les tests de façon séquentielle (--runInBand)

Pour créer un nouveau test, ajoutez un fichier `.test.ts` à côté du code à tester.
