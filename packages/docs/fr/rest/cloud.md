---
title: "API Cloud"
sidebarTitle: "Cloud"
description: "Endpoints de l'API REST pour l'authentification, l'état de connexion, le solde de crédits et la gestion des agents Eliza Cloud."
---

L'API cloud connecte l'agent local Eliza à Eliza Cloud pour l'inférence hébergée dans le cloud, les crédits et la gestion des agents à distance. La connexion utilise un flux de type OAuth basé sur le navigateur avec un sondage pour la finalisation de la session.

La facturation est désormais censée rester dans l'application chaque fois qu'Eliza Cloud expose les endpoints de facturation requis. Les valeurs `topUpUrl` renvoyées par `/api/cloud/status` et `/api/cloud/credits` doivent être traitées comme un repli hébergé, et non comme l'expérience utilisateur principale.

<div id="endpoints">

## Endpoints

</div>

<div id="post-apicloudlogin">

### POST /api/cloud/login

</div>

Démarre le flux de connexion Eliza Cloud. Crée une session sur le cloud et renvoie une URL de navigateur pour que l'utilisateur s'authentifie. Sondez `GET /api/cloud/login/status` avec le `sessionId` renvoyé pour vérifier la finalisation.

**Réponse**

```json
{
  "ok": true,
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "browserUrl": "https://www.elizacloud.ai/auth/cli-login?session=550e8400-e29b-41d4-a716-446655440000"
}
```

---

<div id="get-apicloudloginstatus">

### GET /api/cloud/login/status

</div>

Sonde le statut d'une session de connexion. Lorsque le statut est `"authenticated"`, la clé API est automatiquement enregistrée dans la configuration et appliquée à l'environnement du processus.

Lorsque la fonctionnalité de portefeuille cloud est activée (`ENABLE_CLOUD_WALLET=1`), une connexion réussie déclenche également un provisionnement « au mieux » du portefeuille cloud. L'agent tente d'importer les portefeuilles EVM et Solana depuis Eliza Cloud et de les définir comme source de portefeuille principale. Si le provisionnement échoue, la connexion reste réussie — la clé API est enregistrée, et l'échec du provisionnement du portefeuille est enregistré sans affecter la réponse d'authentification. Vous pouvez réessayer manuellement le provisionnement du portefeuille plus tard en utilisant `POST /api/wallet/refresh-cloud`.

**Paramètres de requête**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `sessionId` | string | Oui | ID de session renvoyé par `POST /api/cloud/login` |

**Réponse (pending)**

```json
{
  "status": "pending"
}
```

**Réponse (authenticated)**

```json
{
  "status": "authenticated",
  "keyPrefix": "eca-..."
}
```

**Valeurs de statut possibles**

| Statut | Description |
|--------|-------------|
| `"pending"` | L'utilisateur n'a pas encore terminé l'authentification |
| `"authenticated"` | Connexion réussie — la clé API a été enregistrée |
| `"expired"` | La session a expiré ou n'a pas été trouvée |
| `"error"` | Une erreur est survenue lors de la communication avec Eliza Cloud |

---

<div id="get-apicloudstatus">

### GET /api/cloud/status

</div>

Obtient l'état de connexion au cloud, l'état d'authentification et l'URL de facturation.

**Réponse (connecté)**

```json
{
  "connected": true,
  "enabled": true,
  "cloudVoiceProxyAvailable": true,
  "hasApiKey": true,
  "userId": "user-123",
  "organizationId": "org-456",
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

**Réponse (non connecté)**

```json
{
  "connected": false,
  "enabled": false,
  "cloudVoiceProxyAvailable": false,
  "hasApiKey": false,
  "reason": "not_authenticated"
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `connected` | boolean | Si le service d'authentification cloud est authentifié |
| `enabled` | boolean | Si le mode cloud est activé dans la configuration |
| `cloudVoiceProxyAvailable` | boolean | Si le proxy vocal cloud est disponible pour la session en cours |
| `hasApiKey` | boolean | Si une clé API est présente dans la configuration |
| `userId` | string | ID de l'utilisateur authentifié (lorsque connecté) |
| `organizationId` | string | ID de l'organisation authentifiée (lorsque connecté) |
| `topUpUrl` | string | URL vers la page de facturation cloud |
| `reason` | string | Raison de l'état déconnecté |

---

<div id="get-apicloudcredits">

### GET /api/cloud/credits

</div>

Obtient le solde des crédits cloud. Renvoie un solde `null` lorsque non connecté.

**Réponse**

```json
{
  "connected": true,
  "balance": 15.50,
  "low": false,
  "critical": false,
  "authRejected": false,
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `balance` | number \| null | Solde des crédits en dollars |
| `low` | boolean | `true` lorsque le solde est inférieur à $2.00 |
| `critical` | boolean | `true` lorsque le solde est inférieur à $0.50 |
| `authRejected` | boolean | `true` lorsque la clé API cloud a été rejetée lors de la vérification des crédits |

---

<div id="billing-proxy-endpoints">

### Endpoints proxy de facturation

</div>

Ces endpoints servent de proxy aux APIs de facturation authentifiées d'Eliza Cloud via le backend local Eliza afin que l'application de bureau puisse garder la facturation, les méthodes de paiement et les recharges dans l'application. Ils nécessitent une connexion active à Eliza Cloud car le serveur local transmet la clé API cloud enregistrée.

Utilisez `topUpUrl` uniquement comme repli hébergé si Eliza Cloud ne renvoie pas un flux de paiement intégré ou un devis crypto que l'application peut afficher directement.

<div id="get-apicloudbillingsummary">

#### GET /api/cloud/billing/summary

</div>

Obtient le résumé de facturation actuel d'Eliza Cloud.

**Réponse typique**

```json
{
  "balance": 15.5,
  "currency": "USD",
  "embeddedCheckoutEnabled": false,
  "hostedCheckoutEnabled": true,
  "cryptoEnabled": true
}
```

<div id="get-apicloudbillingpayment-methods">

#### GET /api/cloud/billing/payment-methods

</div>

Liste les méthodes de paiement enregistrées pour le compte Eliza Cloud authentifié.

<div id="get-apicloudbillinghistory">

#### GET /api/cloud/billing/history

</div>

Liste l'activité de facturation récente, y compris les recharges et l'historique des règlements.

<div id="post-apicloudbillingcheckout">

#### POST /api/cloud/billing/checkout

</div>

Crée une session de paiement de facturation.

**Requête**

```json
{
  "amountUsd": 25,
  "mode": "hosted"
}
```

**Réponse typique**

```json
{
  "provider": "stripe",
  "mode": "hosted",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_xxx...",
  "sessionId": "cs_xxx..."
}
```

Eliza préfère le paiement intégré lorsqu'Eliza Cloud le prend en charge, mais l'intégration actuelle de facturation cloud peut encore renvoyer une URL de paiement hébergée.

<div id="post-apicloudbillingcryptoquote">

#### POST /api/cloud/billing/crypto/quote

</div>

Demande une facture ou un devis crypto pour une recharge de crédits.

**Requête**

```json
{
  "amountUsd": 25,
  "walletAddress": "0xabc123..."
}
```

**Réponse typique**

```json
{
  "provider": "oxapay",
  "network": "BEP20",
  "currency": "USDC",
  "amount": "25.000",
  "amountUsd": 25,
  "paymentLinkUrl": "https://pay.example.com/track_123",
  "expiresAt": "2026-03-15T01:00:00.000Z"
}
```

---

<div id="post-apiclouddisconnect">

### POST /api/cloud/disconnect

</div>

Déconnecte d'Eliza Cloud. Supprime la clé API de la configuration, de l'environnement du processus et de l'enregistrement de la base de données de l'agent.

**Réponse**

```json
{
  "ok": true,
  "status": "disconnected"
}
```

---

<div id="get-apicloudagents">

### GET /api/cloud/agents

</div>

Liste les agents cloud. Nécessite une connexion cloud active.

**Réponse**

```json
{
  "ok": true,
  "agents": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "My Cloud Agent",
      "status": "running",
      "createdAt": "2024-06-10T12:00:00Z"
    }
  ]
}
```

---

<div id="post-apicloudagents">

### POST /api/cloud/agents

</div>

Crée un nouvel agent cloud. Nécessite une connexion cloud active.

**Requête**

```json
{
  "agentName": "My Cloud Agent",
  "agentConfig": { "character": "eliza" },
  "environmentVars": { "OPENAI_API_KEY": "<OPENAI_API_KEY>" }
}
```

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `agentName` | string | Oui | Nom d'affichage de l'agent cloud |
| `agentConfig` | object | Non | Objet de configuration de l'agent |
| `environmentVars` | object | Non | Variables d'environnement à définir sur l'agent cloud |

**Réponse (201 Created)**

```json
{
  "ok": true,
  "agent": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "My Cloud Agent",
    "status": "provisioning"
  }
}
```

---

<div id="post-apicloudagentsidprovision">

### POST /api/cloud/agents/:id/provision

</div>

Provisionne un agent cloud — connecte l'agent local à l'instance de l'agent cloud.

**Paramètres de chemin**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `id` | UUID | Oui | ID de l'agent cloud |

**Réponse**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "My Cloud Agent",
  "status": { "connected": true }
}
```

---

<div id="post-apicloudagentsidshutdown">

### POST /api/cloud/agents/:id/shutdown

</div>

Arrête et supprime un agent cloud.

**Paramètres de chemin**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `id` | UUID | Oui | ID de l'agent cloud |

**Réponse**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "stopped"
}
```

---

<div id="post-apicloudagentsidconnect">

### POST /api/cloud/agents/:id/connect

</div>

Connecte à un agent cloud existant (en se déconnectant d'abord de tout agent actuellement actif).

**Paramètres de chemin**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `id` | UUID | Oui | ID de l'agent cloud |

**Réponse**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "My Cloud Agent",
  "status": { "connected": true }
}
```
