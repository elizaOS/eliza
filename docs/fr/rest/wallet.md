---
title: "API de Portefeuille"
sidebarTitle: "Wallet"
description: "Endpoints de l'API REST pour gérer les portefeuilles EVM et Solana, les soldes, les NFT et les clés."
---

L'API de portefeuille donne accès à l'identité on-chain de l'agent sur les chaînes compatibles EVM et sur Solana. La consultation des soldes et des NFT nécessite des clés API (Alchemy pour EVM, Helius pour Solana) configurées via `PUT /api/wallet/config`.

<Warning>
L'endpoint `POST /api/wallet/export` renvoie les clés privées en texte clair. Il nécessite une confirmation explicite et est consigné comme événement de sécurité.
</Warning>

<div id="endpoints">

## Endpoints

</div>

<div id="get-apiwalletaddresses">

### GET /api/wallet/addresses

</div>

Récupère les adresses de portefeuille EVM et Solana de l'agent.

**Réponse**

```json
{
  "evmAddress": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "solanaAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU"
}
```

---

<div id="get-apiwalletbalances">

### GET /api/wallet/balances

</div>

Récupère les soldes de jetons sur toutes les chaînes prises en charge. Nécessite `ALCHEMY_API_KEY` pour les chaînes EVM et `HELIUS_API_KEY` pour Solana. Renvoie `null` pour les chaînes dont la clé API requise n'est pas configurée.

**Réponse**

```json
{
  "evm": {
    "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "chains": [
      {
        "chainId": 1,
        "name": "Ethereum",
        "nativeBalance": "1.5",
        "tokens": []
      }
    ]
  },
  "solana": {
    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU",
    "nativeBalance": "2.5",
    "tokens": []
  }
}
```

---

<div id="get-apiwalletnfts">

### GET /api/wallet/nfts

</div>

Récupère les NFT détenus par l'agent sur les chaînes EVM et Solana. Nécessite `ALCHEMY_API_KEY` pour EVM et `HELIUS_API_KEY` pour Solana.

**Réponse**

```json
{
  "evm": [
    {
      "contractAddress": "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
      "tokenId": "1234",
      "name": "Bored Ape #1234",
      "imageUrl": "https://..."
    }
  ],
  "solana": {
    "nfts": []
  }
}
```

---

<div id="get-apiwalletconfig">

### GET /api/wallet/config

</div>

Récupère le statut de configuration des clés API du portefeuille, les sélections de fournisseur RPC et les adresses de portefeuille actuelles. Les valeurs des clés ne sont pas renvoyées — seulement leur statut défini/non défini.

Lorsque la fonctionnalité de portefeuille cloud est activée (`ENABLE_CLOUD_WALLET=1`), la réponse inclut les champs supplémentaires `wallets` et `primary` qui décrivent tous les portefeuilles disponibles (local et cloud) et quelle source est principale pour chaque chaîne. Les champs `evmAddress` et `solanaAddress` reflètent le portefeuille actuellement principal.

**Réponse**

```json
{
  "selectedRpcProviders": {
    "evm": "alchemy",
    "bsc": "alchemy",
    "solana": "helius-birdeye"
  },
  "walletNetwork": "mainnet",
  "legacyCustomChains": [],
  "alchemyKeySet": true,
  "infuraKeySet": false,
  "ankrKeySet": false,
  "nodeRealBscRpcSet": false,
  "quickNodeBscRpcSet": false,
  "managedBscRpcReady": false,
  "cloudManagedAccess": false,
  "heliusKeySet": true,
  "birdeyeKeySet": false,
  "evmChains": ["ethereum", "base"],
  "evmAddress": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "solanaAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU",
  "walletSource": "local",
  "automationMode": "user-sign-only",
  "pluginEvmLoaded": true,
  "pluginEvmRequired": false,
  "executionReady": true,
  "executionBlockedReason": null,
  "solanaSigningAvailable": true
}
```

**Champs supplémentaires lorsque le portefeuille cloud est activé**

Lorsque `ENABLE_CLOUD_WALLET` est actif, la réponse inclut également :

```json
{
  "wallets": [
    {
      "source": "local",
      "chain": "evm",
      "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "provider": "local",
      "primary": false
    },
    {
      "source": "cloud",
      "chain": "evm",
      "address": "0x1234...abcd",
      "provider": "privy",
      "primary": true
    },
    {
      "source": "local",
      "chain": "solana",
      "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU",
      "provider": "local",
      "primary": true
    }
  ],
  "primary": {
    "evm": "cloud",
    "solana": "local"
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `selectedRpcProviders` | object | Fournisseur RPC actuellement sélectionné pour chaque chaîne (`evm`, `bsc`, `solana`) |
| `walletNetwork` | string | Réseau de portefeuille actif (`"mainnet"` ou `"testnet"`) |
| `legacyCustomChains` | array | Configurations héritées de chaînes personnalisées (peut être vide) |
| `alchemyKeySet` | boolean | Si une clé API Alchemy est configurée |
| `infuraKeySet` | boolean | Si une clé API Infura est configurée |
| `ankrKeySet` | boolean | Si une clé API Ankr est configurée |
| `nodeRealBscRpcSet` | boolean | Si un endpoint RPC BSC NodeReal est configuré |
| `quickNodeBscRpcSet` | boolean | Si un endpoint RPC BSC QuickNode est configuré |
| `managedBscRpcReady` | boolean | Si un endpoint RPC BSC géré est disponible |
| `cloudManagedAccess` | boolean | Si l'accès au portefeuille est géré via Eliza Cloud |
| `heliusKeySet` | boolean | Si une clé API Helius est configurée |
| `birdeyeKeySet` | boolean | Si une clé API Birdeye est configurée |
| `evmChains` | string[] | Liste des chaînes EVM actives |
| `evmAddress` | string \| null | Adresse actuelle du portefeuille EVM principal |
| `solanaAddress` | string \| null | Adresse actuelle du portefeuille Solana principal |
| `walletSource` | string | Source de portefeuille active (`"local"`, `"cloud"`, etc.) |
| `automationMode` | string | Mode actuel d'automatisation du trading |
| `pluginEvmLoaded` | boolean | Si le plugin EVM est chargé |
| `pluginEvmRequired` | boolean | Si le plugin EVM est requis |
| `executionReady` | boolean | Si l'exécution des trades est prête |
| `executionBlockedReason` | string \| null | Raison pour laquelle l'exécution est bloquée, le cas échéant |
| `solanaSigningAvailable` | boolean | Si la signature des transactions Solana est disponible (clé locale ou cloud comme principal) |
| `wallets` | array | Toutes les entrées de portefeuille à travers les sources locales et cloud (uniquement lorsque le portefeuille cloud est activé) |
| `wallets[].source` | string | `"local"` ou `"cloud"` |
| `wallets[].chain` | string | `"evm"` ou `"solana"` |
| `wallets[].address` | string | Adresse du portefeuille |
| `wallets[].provider` | string | `"local"`, `"privy"` ou `"steward"` |
| `wallets[].primary` | boolean | Si ce portefeuille est le principal pour sa chaîne |
| `primary` | object | Associe chaque chaîne à sa source de portefeuille principale (uniquement lorsque le portefeuille cloud est activé) |
| `primary.evm` | string | `"local"` ou `"cloud"` |
| `primary.solana` | string | `"local"` ou `"cloud"` |

---

<div id="put-apiwalletconfig">

### PUT /api/wallet/config

</div>

Met à jour les clés API du portefeuille et les sélections de fournisseur RPC. Vous pouvez définir des clés API, changer de fournisseur RPC par chaîne, ou les deux en une seule requête. Définir `HELIUS_API_KEY` configure également automatiquement `SOLANA_RPC_URL`.

Lorsque toutes les sélections de fournisseur RPC sont définies sur `"eliza-cloud"`, le drapeau de fonctionnalité de portefeuille cloud (`ENABLE_CLOUD_WALLET`) est automatiquement activé.

**Requête (clés API)**

```json
{
  "ALCHEMY_API_KEY": "alchemy-key-here",
  "HELIUS_API_KEY": "helius-key-here"
}
```

**Requête (sélections de fournisseur RPC)**

Utilisez le champ `selections` pour changer de fournisseur RPC pour une ou plusieurs chaînes. Par exemple, définir une chaîne sur `"eliza-cloud"` délègue l'accès RPC à Eliza Cloud.

```json
{
  "selections": {
    "evm": "eliza-cloud",
    "bsc": "eliza-cloud",
    "solana": "eliza-cloud"
  }
}
```

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `ALCHEMY_API_KEY` | string | Non | Clé API Alchemy pour les recherches de solde/NFT EVM |
| `INFURA_API_KEY` | string | Non | Clé API Infura |
| `ANKR_API_KEY` | string | Non | Clé API Ankr |
| `HELIUS_API_KEY` | string | Non | Clé API Helius pour les recherches Solana — définit aussi `SOLANA_RPC_URL` |
| `BIRDEYE_API_KEY` | string | Non | Clé API Birdeye pour les prix de jetons Solana |
| `selections` | object | Non | Mappage des identifiants de chaîne (`evm`, `bsc`, `solana`) vers des noms de fournisseur RPC (par exemple `"alchemy"`, `"eliza-cloud"`) |

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="post-apiwalletimport">

### POST /api/wallet/import

</div>

Importe une clé privée existante pour EVM ou Solana. La chaîne est détectée automatiquement si elle n'est pas spécifiée.

**Requête**

```json
{
  "privateKey": "0xabc123...",
  "chain": "evm"
}
```

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `privateKey` | string | Oui | Clé privée à importer |
| `chain` | string | Non | `"evm"` ou `"solana"` — détectée automatiquement si omise |

**Réponse**

```json
{
  "ok": true,
  "chain": "evm",
  "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
}
```

---

<div id="post-apiwalletgenerate">

### POST /api/wallet/generate

</div>

Génère un ou plusieurs nouveaux portefeuilles. Par défaut, les clés sont générées localement et enregistrées dans la configuration. Lorsque le pont Steward est configuré et que `source` n'est pas `"local"`, la génération de portefeuille est déléguée à Steward.

**Requête**

```json
{
  "chain": "both",
  "source": "local"
}
```

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `chain` | string | Non | `"evm"`, `"solana"` ou `"both"` (par défaut : `"both"`) |
| `source` | string | Non | `"local"` ou `"steward"`. Lorsqu'il est omis, la valeur par défaut est Steward s'il est configuré, sinon local. Définissez à `"local"` pour forcer la génération locale de clés même lorsque Steward est disponible. |

**Réponse**

```json
{
  "ok": true,
  "wallets": [
    { "chain": "evm", "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    { "chain": "solana", "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU" }
  ],
  "source": "local"
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `wallets` | array | Adresses de portefeuille générées avec leur type de chaîne |
| `source` | string | `"local"` ou `"steward"` — indique quel fournisseur a généré les portefeuilles |

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 400 | `chain` n'est ni `"evm"`, ni `"solana"`, ni `"both"` |
| 400 | `source` n'est ni `"local"` ni `"steward"` |

---

<div id="post-apiwalletexport">

### POST /api/wallet/export

</div>

Exporte les clés privées en texte clair. Nécessite une confirmation explicite. Cette action est consignée comme événement de sécurité.

**Requête**

```json
{
  "confirm": true
}
```

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `confirm` | boolean | Oui | Doit être `true` pour continuer |
| `exportToken` | string | Non | Jeton d'exportation à usage unique en option pour une sécurité supplémentaire |

**Réponse**

```json
{
  "evm": {
    "privateKey": "0xabc123...",
    "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
  },
  "solana": {
    "privateKey": "base58encodedkey...",
    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU"
  }
}
```

---

<div id="steward-bridge">

## Pont Steward

</div>

Le pont Steward permet la signature déléguée de transactions via un service de politiques externe. Lorsqu'il est configuré, les endpoints de trade et de transfert acheminent les demandes de signature via Steward, qui peut approuver, rejeter ou retenir les transactions pour examen de politique avant leur diffusion.

<div id="get-apiwalletsteward-status">

### GET /api/wallet/steward-status

</div>

Récupère le statut actuel de la connexion du pont Steward, y compris si le service est configuré, joignable et quelle identité d'agent est utilisée.

**Réponse**

```json
{
  "configured": true,
  "available": true,
  "connected": true,
  "baseUrl": "https://steward.example.com",
  "agentId": "agent-1",
  "evmAddress": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "error": null
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `configured` | boolean | Si l'URL de l'API Steward est définie |
| `available` | boolean | Si le service Steward a répondu avec succès |
| `connected` | boolean | Si le pont a établi une connexion |
| `baseUrl` | string \| null | URL de base de l'API Steward, si configurée |
| `agentId` | string \| null | Identité d'agent utilisée pour les requêtes Steward |
| `evmAddress` | string \| null | Adresse de portefeuille EVM associée à cet agent |
| `error` | string \| null | Message d'erreur si la vérification de connexion a échoué |

---

<div id="trading">

## Trading

</div>

<div id="post-apiwallettradepreflight">

### POST /api/wallet/trade/preflight

</div>

Exécute une vérification préalable pour vérifier que le portefeuille et le RPC sont prêts pour un trade BSC.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `tokenAddress` | string | Non | Adresse du contrat du jeton à valider (optionnel) |

**Réponse**

Renvoie un objet de préparation avec le solde du portefeuille, le statut RPC et tout problème bloquant.

---

<div id="post-apiwallettradequote">

### POST /api/wallet/trade/quote

</div>

Obtient une cotation de prix pour un swap de jeton BSC avant l'exécution.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `side` | string | Oui | `"buy"` ou `"sell"` |
| `tokenAddress` | string | Oui | Adresse du contrat du jeton |
| `amount` | string | Oui | Montant du trade (en unités lisibles par l'humain) |
| `slippageBps` | number | Non | Tolérance de slippage en points de base |

**Réponse**

Renvoie un objet de cotation avec le montant de sortie estimé, l'impact sur le prix et les détails de la route.

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 400 | `side`, `tokenAddress` ou `amount` manquant |

---

<div id="post-apiwallettradeexecute">

### POST /api/wallet/trade/execute

</div>

Exécute un trade de jeton sur BSC. Le comportement dépend de la configuration du portefeuille, de la disponibilité du pont Steward et de la confirmation :

- Sans `confirm: true` ou sans clé privée locale, renvoie une transaction non signée pour signature côté client.
- Avec `confirm: true`, une clé locale et les permissions de trade appropriées, exécute le trade on-chain et renvoie le reçu.
- Lorsque le pont Steward est configuré, la signature est déléguée au service Steward. Steward peut approuver la transaction immédiatement, la retenir pour examen de politique ou la rejeter selon les politiques configurées.

**En-têtes de la requête**

| En-tête | Type | Requis | Description |
|---------|------|--------|-------------|
| `x-eliza-agent-action` | string | Non | Définissez à `1`, `true`, `yes` ou `agent` pour marquer cela comme une requête automatisée par agent. Affecte la résolution du mode de permission de trade. |

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `side` | string | Oui | `"buy"` ou `"sell"` |
| `tokenAddress` | string | Oui | Adresse du contrat du jeton |
| `amount` | string | Oui | Montant du trade (en unités lisibles par l'humain) |
| `slippageBps` | number | Non | Tolérance de slippage en points de base |
| `deadlineSeconds` | number | Non | Date limite de transaction en secondes |
| `confirm` | boolean | Non | Définissez à `true` pour exécuter immédiatement avec une clé locale |
| `source` | string | Non | `"agent"` ou `"manual"` — attribution pour le suivi du registre |

**Réponse (non signée — l'utilisateur doit signer)**

Renvoyée lorsque `confirm` n'est pas `true`, qu'aucune clé locale n'est disponible ou que le mode de permission de trade ne permet pas l'exécution côté serveur.

```json
{
  "ok": true,
  "side": "buy",
  "mode": "user-sign",
  "quote": {
    "side": "buy",
    "tokenAddress": "0x...",
    "slippageBps": 100,
    "route": "TOKEN/WBNB",
    "routerAddress": "0x...",
    "quoteIn": { "symbol": "BNB", "amount": "0.1", "amountWei": "100000000000000000" },
    "quoteOut": { "symbol": "TOKEN", "amount": "1000", "amountWei": "1000000000000000000000" }
  },
  "executed": false,
  "requiresUserSignature": true,
  "unsignedTx": {
    "to": "0x...",
    "data": "0x...",
    "valueWei": "100000000000000000",
    "chainId": 56
  },
  "requiresApproval": false
}
```

Pour les ordres de vente, la réponse inclut un champ supplémentaire `unsignedApprovalTx` lorsque le routeur a besoin d'une approbation de jeton :

```json
{
  "requiresApproval": true,
  "unsignedApprovalTx": {
    "to": "0x...",
    "data": "0x...",
    "valueWei": "0",
    "chainId": 56
  }
}
```

**Réponse (exécutée)**

Renvoyée lorsque le trade a été signé et diffusé (localement ou via Steward).

```json
{
  "ok": true,
  "side": "buy",
  "mode": "local",
  "quote": { "..." : "..." },
  "executed": true,
  "requiresUserSignature": false,
  "unsignedTx": { "..." : "..." },
  "requiresApproval": false,
  "execution": {
    "hash": "0x...",
    "nonce": 42,
    "gasLimit": "250000",
    "valueWei": "100000000000000000",
    "explorerUrl": "https://bscscan.com/tx/0x...",
    "blockNumber": null,
    "status": "pending",
    "approvalHash": "0x..."
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `mode` | string | `"local-key"`, `"user-sign"`, `"steward"` ou `"local"` |
| `execution.hash` | string | Hash de la transaction on-chain |
| `execution.nonce` | number \| null | Nonce de la transaction (`null` lorsqu'elle est signée par Steward) |
| `execution.status` | string | `"pending"` immédiatement après la diffusion |
| `execution.approvalHash` | string \| undefined | Hash de la transaction d'approbation de jeton (ordres de vente uniquement) |

**Réponse (Steward en attente d'approbation)**

Renvoyée lorsque Steward retient la transaction pour examen de politique au lieu de la signer immédiatement.

```json
{
  "ok": true,
  "side": "buy",
  "mode": "steward",
  "quote": { "..." : "..." },
  "executed": false,
  "requiresUserSignature": false,
  "unsignedTx": { "..." : "..." },
  "requiresApproval": false,
  "execution": {
    "status": "pending_approval",
    "policyResults": [
      { "policy": "max-trade-value", "result": "pending" }
    ]
  }
}
```

**Réponse (rejet de politique Steward)**

Renvoyée avec le statut `403` lorsque Steward rejette la transaction selon des règles de politique.

```json
{
  "ok": false,
  "mode": "steward",
  "executed": false,
  "requiresUserSignature": false,
  "error": "Policy rejected",
  "execution": {
    "status": "rejected",
    "policyResults": [
      { "policy": "max-trade-value", "result": "denied" }
    ]
  }
}
```

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 400 | `side`, `tokenAddress` ou `amount` manquant |
| 400 | `side` n'est ni `"buy"` ni `"sell"` |
| 403 | Rejet de politique Steward (voir la forme de réponse ci-dessus) |
| 500 | Échec de l'exécution du trade |

---

<div id="get-apiwallettradetx-status">

### GET /api/wallet/trade/tx-status

</div>

Vérifie le statut on-chain d'une transaction de trade précédemment soumise.

**Paramètres de requête**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `hash` | string | Oui | Hash de la transaction |

**Réponse**

```json
{
  "ok": true,
  "hash": "0x...",
  "status": "success",
  "explorerUrl": "https://bscscan.com/tx/0x...",
  "chainId": 56,
  "blockNumber": 12345678,
  "confirmations": 12,
  "nonce": 42,
  "gasUsed": "150000",
  "effectiveGasPriceWei": "3000000000"
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `status` | string | `"pending"`, `"success"`, `"reverted"` ou `"not_found"` |
| `chainId` | number | Toujours `56` (BSC) |

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 400 | Paramètre de requête `hash` manquant |

---

<div id="get-apiwallettradingprofile">

### GET /api/wallet/trading/profile

</div>

Récupère un profil de profits et pertes de trading depuis le registre local des trades.

**Paramètres de requête**

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `window` | string | `30d` | Fenêtre temporelle : `"7d"`, `"30d"` ou `"all"` |
| `source` | string | `all` | Filtrer par attribution : `"agent"`, `"manual"` ou `"all"` |

**Réponse**

Renvoie des statistiques de trading agrégées, y compris les P&L réalisés et non réalisés sur la fenêtre demandée.

---

<div id="post-apiwallettransferexecute">

### POST /api/wallet/transfer/execute

</div>

Transfère des jetons natifs (BNB) ou des jetons ERC-20 sur BSC.

- Sans `confirm: true` ou sans clé privée locale, renvoie une transaction non signée pour signature côté client.
- Avec `confirm: true` et une clé locale, exécute le transfert on-chain.
- Lorsque le pont Steward est configuré, la signature est déléguée au service Steward avec le même flux d'approbation de politique que l'exécution de trade.

**En-têtes de la requête**

| En-tête | Type | Requis | Description |
|---------|------|--------|-------------|
| `x-eliza-agent-action` | string | Non | Définissez à `1`, `true`, `yes` ou `agent` pour marquer cela comme une requête automatisée par agent. Affecte la résolution du mode de permission de trade. |

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `toAddress` | string | Oui | Adresse EVM du destinataire |
| `amount` | string | Oui | Montant à transférer (en unités lisibles par l'humain) |
| `assetSymbol` | string | Oui | Symbole du jeton (par exemple `"BNB"`, `"USDT"`) |
| `tokenAddress` | string | Non | Adresse du contrat ERC-20 (requis pour les jetons non natifs) |
| `confirm` | boolean | Non | Définissez à `true` pour exécuter immédiatement avec une clé locale |

**Réponse (non signée — l'utilisateur doit signer)**

```json
{
  "ok": true,
  "mode": "user-sign",
  "executed": false,
  "requiresUserSignature": true,
  "toAddress": "0x...",
  "amount": "1.5",
  "assetSymbol": "BNB",
  "unsignedTx": {
    "chainId": 56,
    "from": "0x...",
    "to": "0x...",
    "data": "0x",
    "valueWei": "1500000000000000000",
    "explorerUrl": "https://bscscan.com",
    "assetSymbol": "BNB",
    "amount": "1.5"
  }
}
```

Pour les transferts ERC-20, `unsignedTx.to` est l'adresse du contrat du jeton, `unsignedTx.data` contient l'appel `transfer` encodé et `unsignedTx.tokenAddress` est inclus.

**Réponse (exécutée)**

```json
{
  "ok": true,
  "mode": "local",
  "executed": true,
  "requiresUserSignature": false,
  "toAddress": "0x...",
  "amount": "1.5",
  "assetSymbol": "BNB",
  "unsignedTx": { "..." : "..." },
  "execution": {
    "hash": "0x...",
    "nonce": 42,
    "gasLimit": "21000",
    "valueWei": "1500000000000000000",
    "explorerUrl": "https://bscscan.com/tx/0x...",
    "blockNumber": null,
    "status": "pending"
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `mode` | string | `"local-key"`, `"user-sign"`, `"steward"` ou `"local"` |
| `execution.nonce` | number \| null | Nonce de la transaction (`null` lorsqu'elle est signée par Steward) |
| `execution.status` | string | `"pending"` immédiatement après la diffusion |

**Réponse (Steward en attente d'approbation)**

```json
{
  "ok": true,
  "mode": "steward",
  "executed": false,
  "requiresUserSignature": false,
  "toAddress": "0x...",
  "amount": "1.5",
  "assetSymbol": "BNB",
  "unsignedTx": { "..." : "..." },
  "execution": {
    "status": "pending_approval",
    "policyResults": [
      { "policy": "max-transfer-value", "result": "pending" }
    ]
  }
}
```

**Réponse (rejet de politique Steward)**

Renvoyée avec le statut `403` lorsque Steward rejette la transaction selon des règles de politique.

```json
{
  "ok": false,
  "mode": "steward",
  "executed": false,
  "requiresUserSignature": false,
  "error": "Policy rejected",
  "execution": {
    "status": "rejected",
    "policyResults": [
      { "policy": "max-transfer-value", "result": "denied" }
    ]
  }
}
```

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 400 | `toAddress`, `amount` ou `assetSymbol` manquant |
| 400 | Format d'adresse EVM invalide |
| 403 | Rejet de politique Steward (voir la forme de réponse ci-dessus) |
| 500 | Échec de l'exécution du transfert |

---

<div id="post-apiwalletproduction-defaults">

### POST /api/wallet/production-defaults

</div>

Applique des valeurs par défaut opiniâtres de production pour la configuration de trading du portefeuille (mode de permission de trade, paramètres RPC, etc.).

**Réponse**

```json
{
  "ok": true,
  "applied": [
    "tradePermissionMode=user-sign-only",
    "bscRpcUrl=https://bsc-dataseed.binance.org"
  ],
  "tradePermissionMode": "user-sign-only"
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `applied` | string[] | Liste des changements de configuration qui ont été appliqués |
| `tradePermissionMode` | string | Le mode de permission de trade résultant |

---

<div id="cloud-wallet">

## Portefeuille cloud

</div>

Ces endpoints gèrent l'architecture de portefeuille dual (local + cloud). Ils sont contrôlés par le drapeau de fonctionnalité `ENABLE_CLOUD_WALLET` et renvoient `404` lorsque le drapeau est désactivé.

<Info>
Les portefeuilles cloud sont provisionnés via Eliza Cloud et prennent en charge des fournisseurs comme Privy et Steward. Lorsque le portefeuille cloud est activé, l'agent peut détenir à la fois des portefeuilles locaux et gérés dans le cloud pour chaque chaîne, avec un désigné comme principal.
</Info>

<div id="post-apiwalletprimary">

### POST /api/wallet/primary

</div>

Définit la source de portefeuille principale pour une chaîne. Le portefeuille principal est utilisé pour les recherches de solde, l'exécution des trades et l'affichage des adresses. Changer le principal déclenche un rechargement du runtime pour relier les plugins de portefeuille.

**Requête**

```json
{
  "chain": "evm",
  "source": "cloud"
}
```

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `chain` | string | Oui | `"evm"` ou `"solana"` |
| `source` | string | Oui | `"local"` ou `"cloud"` |

**Réponse**

```json
{
  "ok": true,
  "chain": "evm",
  "source": "cloud",
  "restarting": true
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `chain` | string | La chaîne qui a été mise à jour |
| `source` | string | La nouvelle source principale |
| `restarting` | boolean | Si le runtime redémarre pour appliquer le changement |
| `warnings` | string[] | Avertissements optionnels (par exemple, problèmes de sauvegarde de configuration) |

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 400 | `chain` n'est ni `"evm"` ni `"solana"` |
| 400 | `source` n'est ni `"local"` ni `"cloud"` |
| 404 | La fonctionnalité de portefeuille cloud n'est pas activée |
| 500 | Échec de la persistance de la configuration |

---

<div id="post-apiwalletrefresh-cloud">

### POST /api/wallet/refresh-cloud

</div>

Interroge à nouveau Eliza Cloud pour obtenir les derniers descripteurs de portefeuille cloud et met à jour le cache local. Réinterroge toutes les chaînes pour capter les changements d'adresses en amont tels que la rotation ou la migration de portefeuille. Si une chaîne échoue au rafraîchissement, le descripteur précédemment mis en cache est conservé.

Changer le principal déclenche un rechargement du runtime lorsque les liaisons de portefeuille ont changé.

**Requête**

Aucun corps de requête requis.

**Réponse**

```json
{
  "ok": true,
  "restarting": true,
  "wallets": {
    "evm": {
      "address": "0x1234...abcd",
      "provider": "privy"
    },
    "solana": {
      "address": "Abc123...xyz",
      "provider": "steward"
    }
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `restarting` | boolean | Si le runtime redémarre en raison de liaisons de portefeuille modifiées |
| `wallets.evm` | object \| null | Descripteur rafraîchi du portefeuille cloud EVM |
| `wallets.solana` | object \| null | Descripteur rafraîchi du portefeuille cloud Solana |
| `wallets.*.address` | string | Adresse du portefeuille cloud |
| `wallets.*.provider` | string | Fournisseur de portefeuille (`"privy"` ou `"steward"`) |
| `warnings` | string[] | Avertissements optionnels pour des échecs partiels ou des problèmes de sauvegarde de configuration |

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 400 | Cloud non lié — aucune clé API configurée |
| 400 | Aucun agent configuré |
| 404 | La fonctionnalité de portefeuille cloud n'est pas activée |
| 502 | Échec du rafraîchissement du portefeuille cloud (erreur amont) |

---

<div id="common-error-codes">

## Codes d'erreur communs

</div>

| Statut | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Le corps de la requête est malformé ou il manque des champs requis |
| 401 | `UNAUTHORIZED` | Jeton d'authentification manquant ou invalide |
| 404 | `NOT_FOUND` | La ressource demandée n'existe pas |
| 400 | `INVALID_KEY` | Format de clé privée invalide |
| 400 | `INVALID_ADDRESS` | Format d'adresse EVM invalide |
| 403 | `EXPORT_FORBIDDEN` | L'exportation n'est pas autorisée sans confirmation appropriée |
| 403 | `TRADE_FORBIDDEN` | Permission de trade refusée |
| 403 | `STEWARD_POLICY_REJECTED` | Le moteur de politiques Steward a rejeté la transaction. Le corps de la réponse inclut `execution.policyResults` avec des détails sur les politiques évaluées. |
| 500 | `INSUFFICIENT_BALANCE` | Le solde du portefeuille est insuffisant pour l'opération |
| 500 | `INTERNAL_ERROR` | Erreur serveur inattendue |
