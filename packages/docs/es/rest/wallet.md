---
title: "API de Wallet"
sidebarTitle: "Wallet"
description: "Endpoints de la API REST para gestionar wallets EVM y Solana, saldos, NFTs y claves."
---

La API de wallet proporciona acceso a la identidad on-chain del agente en cadenas compatibles con EVM y Solana. Las búsquedas de saldos y NFTs requieren claves API (Alchemy para EVM, Helius para Solana) configuradas mediante `PUT /api/wallet/config`.

<Warning>
El endpoint `POST /api/wallet/export` devuelve claves privadas en texto plano. Requiere confirmación explícita y se registra como un evento de seguridad.
</Warning>

<div id="endpoints">

## Endpoints

</div>

<div id="get-apiwalletaddresses">

### GET /api/wallet/addresses

</div>

Obtiene las direcciones de wallet EVM y Solana del agente.

**Respuesta**

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

Obtiene los saldos de tokens en todas las cadenas compatibles. Requiere `ALCHEMY_API_KEY` para las cadenas EVM y `HELIUS_API_KEY` para Solana. Devuelve `null` para las cadenas cuya clave API requerida no esté configurada.

**Respuesta**

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

Obtiene los NFTs que posee el agente en cadenas EVM y Solana. Requiere `ALCHEMY_API_KEY` para EVM y `HELIUS_API_KEY` para Solana.

**Respuesta**

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

Obtiene el estado de configuración de las claves API de la wallet, las selecciones de proveedor RPC y las direcciones de wallet actuales. No se devuelven los valores de las claves — solo su estado configurado/no configurado.

Cuando la función de wallet cloud está habilitada (`ENABLE_CLOUD_WALLET=1`), la respuesta incluye los campos adicionales `wallets` y `primary` que describen todas las wallets disponibles (locales y cloud) y qué fuente es la principal para cada cadena. Los campos `evmAddress` y `solanaAddress` reflejan la wallet que esté actualmente como principal.

**Respuesta**

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

**Campos adicionales cuando la wallet cloud está habilitada**

Cuando `ENABLE_CLOUD_WALLET` está activo, la respuesta también incluye:

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

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `selectedRpcProviders` | object | Proveedor RPC seleccionado actualmente para cada cadena (`evm`, `bsc`, `solana`) |
| `walletNetwork` | string | Red de wallet activa (`"mainnet"` o `"testnet"`) |
| `legacyCustomChains` | array | Configuraciones heredadas de cadenas personalizadas (puede estar vacío) |
| `alchemyKeySet` | boolean | Si hay configurada una clave API de Alchemy |
| `infuraKeySet` | boolean | Si hay configurada una clave API de Infura |
| `ankrKeySet` | boolean | Si hay configurada una clave API de Ankr |
| `nodeRealBscRpcSet` | boolean | Si hay configurado un endpoint RPC BSC de NodeReal |
| `quickNodeBscRpcSet` | boolean | Si hay configurado un endpoint RPC BSC de QuickNode |
| `managedBscRpcReady` | boolean | Si hay disponible un endpoint RPC BSC gestionado |
| `cloudManagedAccess` | boolean | Si el acceso a la wallet se gestiona a través de Eliza Cloud |
| `heliusKeySet` | boolean | Si hay configurada una clave API de Helius |
| `birdeyeKeySet` | boolean | Si hay configurada una clave API de Birdeye |
| `evmChains` | string[] | Lista de cadenas EVM activas |
| `evmAddress` | string \| null | Dirección actual de la wallet EVM principal |
| `solanaAddress` | string \| null | Dirección actual de la wallet Solana principal |
| `walletSource` | string | Fuente de wallet activa (`"local"`, `"cloud"`, etc.) |
| `automationMode` | string | Modo actual de automatización de trading |
| `pluginEvmLoaded` | boolean | Si el plugin EVM está cargado |
| `pluginEvmRequired` | boolean | Si el plugin EVM es requerido |
| `executionReady` | boolean | Si la ejecución de trades está lista |
| `executionBlockedReason` | string \| null | Razón por la que la ejecución está bloqueada, si la hay |
| `solanaSigningAvailable` | boolean | Si la firma de transacciones Solana está disponible (clave local o cloud como principal) |
| `wallets` | array | Todas las entradas de wallet en fuentes locales y cloud (solo cuando la wallet cloud está habilitada) |
| `wallets[].source` | string | `"local"` o `"cloud"` |
| `wallets[].chain` | string | `"evm"` o `"solana"` |
| `wallets[].address` | string | Dirección de la wallet |
| `wallets[].provider` | string | `"local"`, `"privy"` o `"steward"` |
| `wallets[].primary` | boolean | Si esta wallet es la principal para su cadena |
| `primary` | object | Asigna cada cadena a su fuente de wallet principal (solo cuando la wallet cloud está habilitada) |
| `primary.evm` | string | `"local"` o `"cloud"` |
| `primary.solana` | string | `"local"` o `"cloud"` |

---

<div id="put-apiwalletconfig">

### PUT /api/wallet/config

</div>

Actualiza las claves API de la wallet y las selecciones de proveedor RPC. Puede establecer claves API, cambiar proveedores RPC por cadena, o ambos en una sola solicitud. Establecer `HELIUS_API_KEY` también configura automáticamente `SOLANA_RPC_URL`.

Cuando todas las selecciones de proveedor RPC están establecidas en `"eliza-cloud"`, la bandera de función de wallet cloud (`ENABLE_CLOUD_WALLET`) se habilita automáticamente.

**Solicitud (claves API)**

```json
{
  "ALCHEMY_API_KEY": "alchemy-key-here",
  "HELIUS_API_KEY": "helius-key-here"
}
```

**Solicitud (selecciones de proveedor RPC)**

Use el campo `selections` para cambiar proveedores RPC para una o más cadenas. Por ejemplo, establecer una cadena a `"eliza-cloud"` delega el acceso RPC a Eliza Cloud.

```json
{
  "selections": {
    "evm": "eliza-cloud",
    "bsc": "eliza-cloud",
    "solana": "eliza-cloud"
  }
}
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `ALCHEMY_API_KEY` | string | No | Clave API de Alchemy para búsquedas de saldo/NFT en EVM |
| `INFURA_API_KEY` | string | No | Clave API de Infura |
| `ANKR_API_KEY` | string | No | Clave API de Ankr |
| `HELIUS_API_KEY` | string | No | Clave API de Helius para búsquedas en Solana — también establece `SOLANA_RPC_URL` |
| `BIRDEYE_API_KEY` | string | No | Clave API de Birdeye para precios de tokens en Solana |
| `selections` | object | No | Mapa de identificadores de cadena (`evm`, `bsc`, `solana`) a nombres de proveedor RPC (por ejemplo `"alchemy"`, `"eliza-cloud"`) |

**Respuesta**

```json
{
  "ok": true
}
```

---

<div id="post-apiwalletimport">

### POST /api/wallet/import

</div>

Importa una clave privada existente para EVM o Solana. La cadena se detecta automáticamente si no se especifica.

**Solicitud**

```json
{
  "privateKey": "0xabc123...",
  "chain": "evm"
}
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `privateKey` | string | Sí | Clave privada a importar |
| `chain` | string | No | `"evm"` o `"solana"` — se detecta automáticamente si se omite |

**Respuesta**

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

Genera una o más wallets nuevas. De forma predeterminada, las claves se generan localmente y se guardan en la configuración. Cuando el puente de Steward está configurado y `source` no es `"local"`, la generación de wallets se delega a Steward.

**Solicitud**

```json
{
  "chain": "both",
  "source": "local"
}
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `chain` | string | No | `"evm"`, `"solana"` o `"both"` (predeterminado: `"both"`) |
| `source` | string | No | `"local"` o `"steward"`. Cuando se omite, el valor predeterminado es Steward si está configurado, de lo contrario local. Establezca a `"local"` para forzar la generación local de claves incluso cuando Steward esté disponible. |

**Respuesta**

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

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `wallets` | array | Direcciones de wallet generadas con su tipo de cadena |
| `source` | string | `"local"` o `"steward"` — indica qué proveedor generó las wallets |

**Errores**

| Estado | Condición |
|--------|-----------|
| 400 | `chain` no es `"evm"`, `"solana"` ni `"both"` |
| 400 | `source` no es `"local"` ni `"steward"` |

---

<div id="post-apiwalletexport">

### POST /api/wallet/export

</div>

Exporta las claves privadas en texto plano. Requiere confirmación explícita. Esta acción se registra como un evento de seguridad.

**Solicitud**

```json
{
  "confirm": true
}
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `confirm` | boolean | Sí | Debe ser `true` para continuar |
| `exportToken` | string | No | Token opcional de exportación de un solo uso para seguridad adicional |

**Respuesta**

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

## Puente de Steward

</div>

El puente de Steward permite la firma delegada de transacciones a través de un servicio de política externo. Cuando está configurado, los endpoints de trade y transferencia enrutan las solicitudes de firma a través de Steward, que puede aprobar, rechazar o retener transacciones para revisión de políticas antes de que se difundan.

<div id="get-apiwalletsteward-status">

### GET /api/wallet/steward-status

</div>

Obtiene el estado actual de la conexión del puente de Steward, incluyendo si el servicio está configurado, alcanzable y qué identidad de agente se está utilizando.

**Respuesta**

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

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `configured` | boolean | Si la URL de la API de Steward está establecida |
| `available` | boolean | Si el servicio de Steward respondió con éxito |
| `connected` | boolean | Si el puente estableció una conexión |
| `baseUrl` | string \| null | URL base de la API de Steward, si está configurada |
| `agentId` | string \| null | Identidad de agente utilizada para las solicitudes a Steward |
| `evmAddress` | string \| null | Dirección de wallet EVM asociada a este agente |
| `error` | string \| null | Mensaje de error si falló la verificación de conexión |

---

<div id="trading">

## Trading

</div>

<div id="post-apiwallettradepreflight">

### POST /api/wallet/trade/preflight

</div>

Ejecuta una verificación previa para comprobar que la wallet y el RPC estén listos para un trade en BSC.

**Cuerpo de la solicitud**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `tokenAddress` | string | No | Dirección de contrato del token a validar (opcional) |

**Respuesta**

Devuelve un objeto de preparación con el saldo de la wallet, el estado RPC y cualquier problema bloqueante.

---

<div id="post-apiwallettradequote">

### POST /api/wallet/trade/quote

</div>

Obtiene una cotización de precio para un swap de token en BSC antes de ejecutarlo.

**Cuerpo de la solicitud**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `side` | string | Sí | `"buy"` o `"sell"` |
| `tokenAddress` | string | Sí | Dirección de contrato del token |
| `amount` | string | Sí | Cantidad a operar (en unidades legibles por humanos) |
| `slippageBps` | number | No | Tolerancia de slippage en puntos básicos |

**Respuesta**

Devuelve un objeto de cotización con la cantidad de salida estimada, el impacto en el precio y detalles de la ruta.

**Errores**

| Estado | Condición |
|--------|-----------|
| 400 | Falta `side`, `tokenAddress` o `amount` |

---

<div id="post-apiwallettradeexecute">

### POST /api/wallet/trade/execute

</div>

Ejecuta un trade de token en BSC. El comportamiento depende de la configuración de la wallet, la disponibilidad del puente de Steward y la confirmación:

- Sin `confirm: true` o sin una clave privada local, devuelve una transacción sin firmar para firma del lado del cliente.
- Con `confirm: true`, una clave local y los permisos de trade adecuados, ejecuta el trade on-chain y devuelve el recibo.
- Cuando el puente de Steward está configurado, la firma se delega al servicio de Steward. Steward puede aprobar la transacción inmediatamente, retenerla para revisión de políticas o rechazarla según las políticas configuradas.

**Cabeceras de la solicitud**

| Cabecera | Tipo | Requerido | Descripción |
|----------|------|-----------|-------------|
| `x-eliza-agent-action` | string | No | Establezca a `1`, `true`, `yes` o `agent` para marcar esto como una solicitud automatizada por agente. Afecta a la resolución del modo de permiso de trade. |

**Cuerpo de la solicitud**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `side` | string | Sí | `"buy"` o `"sell"` |
| `tokenAddress` | string | Sí | Dirección de contrato del token |
| `amount` | string | Sí | Cantidad a operar (en unidades legibles por humanos) |
| `slippageBps` | number | No | Tolerancia de slippage en puntos básicos |
| `deadlineSeconds` | number | No | Fecha límite de transacción en segundos |
| `confirm` | boolean | No | Establezca a `true` para ejecutar inmediatamente con una clave local |
| `source` | string | No | `"agent"` o `"manual"` — atribución para el seguimiento del libro mayor |

**Respuesta (sin firmar — el usuario debe firmar)**

Se devuelve cuando `confirm` no es `true`, no hay clave local disponible, o el modo de permiso de trade no permite la ejecución del lado del servidor.

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

Para las órdenes de venta, la respuesta incluye un campo adicional `unsignedApprovalTx` cuando el enrutador necesita aprobación de token:

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

**Respuesta (ejecutada)**

Se devuelve cuando el trade fue firmado y difundido (localmente o mediante Steward).

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

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `mode` | string | `"local-key"`, `"user-sign"`, `"steward"` o `"local"` |
| `execution.hash` | string | Hash de la transacción on-chain |
| `execution.nonce` | number \| null | Nonce de la transacción (`null` cuando la firma la realiza Steward) |
| `execution.status` | string | `"pending"` inmediatamente después de la difusión |
| `execution.approvalHash` | string \| undefined | Hash de la transacción de aprobación de token (solo órdenes de venta) |

**Respuesta (Steward aprobación pendiente)**

Se devuelve cuando Steward retiene la transacción para revisión de políticas en lugar de firmarla inmediatamente.

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

**Respuesta (rechazo por política de Steward)**

Se devuelve con estado `403` cuando Steward rechaza la transacción según las reglas de política.

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

**Errores**

| Estado | Condición |
|--------|-----------|
| 400 | Falta `side`, `tokenAddress` o `amount` |
| 400 | `side` no es `"buy"` ni `"sell"` |
| 403 | Rechazo por política de Steward (véase la forma de la respuesta arriba) |
| 500 | La ejecución del trade falló |

---

<div id="get-apiwallettradetx-status">

### GET /api/wallet/trade/tx-status

</div>

Verifica el estado on-chain de una transacción de trade enviada previamente.

**Parámetros de consulta**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `hash` | string | Sí | Hash de la transacción |

**Respuesta**

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

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `status` | string | `"pending"`, `"success"`, `"reverted"` o `"not_found"` |
| `chainId` | number | Siempre `56` (BSC) |

**Errores**

| Estado | Condición |
|--------|-----------|
| 400 | Falta el parámetro de consulta `hash` |

---

<div id="get-apiwallettradingprofile">

### GET /api/wallet/trading/profile

</div>

Obtiene un perfil de pérdidas y ganancias de trading desde el libro mayor local de trades.

**Parámetros de consulta**

| Parámetro | Tipo | Predeterminado | Descripción |
|-----------|------|----------------|-------------|
| `window` | string | `30d` | Ventana de tiempo: `"7d"`, `"30d"` o `"all"` |
| `source` | string | `all` | Filtrar por atribución: `"agent"`, `"manual"` o `"all"` |

**Respuesta**

Devuelve estadísticas de trading agregadas, incluyendo P&L realizado y no realizado durante la ventana solicitada.

---

<div id="post-apiwallettransferexecute">

### POST /api/wallet/transfer/execute

</div>

Transfiere tokens nativos (BNB) o tokens ERC-20 en BSC.

- Sin `confirm: true` o sin una clave privada local, devuelve una transacción sin firmar para firma del lado del cliente.
- Con `confirm: true` y una clave local, ejecuta la transferencia on-chain.
- Cuando el puente de Steward está configurado, la firma se delega al servicio de Steward con el mismo flujo de aprobación de políticas que la ejecución de trades.

**Cabeceras de la solicitud**

| Cabecera | Tipo | Requerido | Descripción |
|----------|------|-----------|-------------|
| `x-eliza-agent-action` | string | No | Establezca a `1`, `true`, `yes` o `agent` para marcar esto como una solicitud automatizada por agente. Afecta a la resolución del modo de permiso de trade. |

**Cuerpo de la solicitud**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `toAddress` | string | Sí | Dirección EVM del destinatario |
| `amount` | string | Sí | Cantidad a transferir (en unidades legibles por humanos) |
| `assetSymbol` | string | Sí | Símbolo del token (por ejemplo `"BNB"`, `"USDT"`) |
| `tokenAddress` | string | No | Dirección del contrato ERC-20 (requerido para tokens no nativos) |
| `confirm` | boolean | No | Establezca a `true` para ejecutar inmediatamente con una clave local |

**Respuesta (sin firmar — el usuario debe firmar)**

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

Para transferencias ERC-20, `unsignedTx.to` es la dirección del contrato del token, `unsignedTx.data` contiene la llamada `transfer` codificada y se incluye `unsignedTx.tokenAddress`.

**Respuesta (ejecutada)**

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

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `mode` | string | `"local-key"`, `"user-sign"`, `"steward"` o `"local"` |
| `execution.nonce` | number \| null | Nonce de la transacción (`null` cuando la firma la realiza Steward) |
| `execution.status` | string | `"pending"` inmediatamente después de la difusión |

**Respuesta (Steward aprobación pendiente)**

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

**Respuesta (rechazo por política de Steward)**

Se devuelve con estado `403` cuando Steward rechaza la transacción según las reglas de política.

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

**Errores**

| Estado | Condición |
|--------|-----------|
| 400 | Falta `toAddress`, `amount` o `assetSymbol` |
| 400 | Formato de dirección EVM no válido |
| 403 | Rechazo por política de Steward (véase la forma de la respuesta arriba) |
| 500 | La ejecución de la transferencia falló |

---

<div id="post-apiwalletproduction-defaults">

### POST /api/wallet/production-defaults

</div>

Aplica valores predeterminados opinados de producción para la configuración de trading de la wallet (modo de permiso de trade, configuración RPC, etc.).

**Respuesta**

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

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `applied` | string[] | Lista de cambios de configuración que se aplicaron |
| `tradePermissionMode` | string | El modo de permiso de trade resultante |

---

<div id="cloud-wallet">

## Wallet cloud

</div>

Estos endpoints gestionan la arquitectura de wallet dual (local + cloud). Están controlados por la bandera de función `ENABLE_CLOUD_WALLET` y devuelven `404` cuando la bandera está desactivada.

<Info>
Las wallets cloud se aprovisionan a través de Eliza Cloud y admiten proveedores como Privy y Steward. Cuando la wallet cloud está habilitada, el agente puede tener tanto wallets locales como gestionadas en la nube para cada cadena, con una designada como principal.
</Info>

<div id="post-apiwalletprimary">

### POST /api/wallet/primary

</div>

Establece la fuente de wallet principal para una cadena. La wallet principal se utiliza para búsquedas de saldo, ejecución de trades y visualización de direcciones. Cambiar la principal desencadena una recarga del runtime para volver a vincular los plugins de wallet.

**Solicitud**

```json
{
  "chain": "evm",
  "source": "cloud"
}
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `chain` | string | Sí | `"evm"` o `"solana"` |
| `source` | string | Sí | `"local"` o `"cloud"` |

**Respuesta**

```json
{
  "ok": true,
  "chain": "evm",
  "source": "cloud",
  "restarting": true
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `chain` | string | La cadena que se actualizó |
| `source` | string | La nueva fuente principal |
| `restarting` | boolean | Si el runtime se está reiniciando para aplicar el cambio |
| `warnings` | string[] | Advertencias opcionales (por ejemplo, problemas al guardar la configuración) |

**Errores**

| Estado | Condición |
|--------|-----------|
| 400 | `chain` no es `"evm"` ni `"solana"` |
| 400 | `source` no es `"local"` ni `"cloud"` |
| 404 | La función de wallet cloud no está habilitada |
| 500 | No se pudo persistir la configuración |

---

<div id="post-apiwalletrefresh-cloud">

### POST /api/wallet/refresh-cloud

</div>

Vuelve a consultar Eliza Cloud para obtener los últimos descriptores de wallet cloud y actualiza la caché local. Vuelve a obtener todas las cadenas para captar cambios de direcciones del servidor como rotación o migración de wallets. Si una cadena no se puede refrescar, se conserva el descriptor previamente cacheado.

Cambiar la principal desencadena una recarga del runtime cuando las vinculaciones de wallet han cambiado.

**Solicitud**

No se requiere cuerpo de solicitud.

**Respuesta**

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

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `restarting` | boolean | Si el runtime se está reiniciando debido a cambios en las vinculaciones de wallet |
| `wallets.evm` | object \| null | Descriptor refrescado de la wallet cloud EVM |
| `wallets.solana` | object \| null | Descriptor refrescado de la wallet cloud Solana |
| `wallets.*.address` | string | Dirección de la wallet cloud |
| `wallets.*.provider` | string | Proveedor de wallet (`"privy"` o `"steward"`) |
| `warnings` | string[] | Advertencias opcionales por fallos parciales o problemas al guardar la configuración |

**Errores**

| Estado | Condición |
|--------|-----------|
| 400 | Cloud no vinculado — no hay clave API configurada |
| 400 | Ningún agente configurado |
| 404 | La función de wallet cloud no está habilitada |
| 502 | Falló el refresco de la wallet cloud (error del servidor) |

---

<div id="common-error-codes">

## Códigos de error comunes

</div>

| Estado | Código | Descripción |
|--------|--------|-------------|
| 400 | `INVALID_REQUEST` | El cuerpo de la solicitud está mal formado o le faltan campos requeridos |
| 401 | `UNAUTHORIZED` | Token de autenticación ausente o no válido |
| 404 | `NOT_FOUND` | El recurso solicitado no existe |
| 400 | `INVALID_KEY` | Formato de clave privada no válido |
| 400 | `INVALID_ADDRESS` | Formato de dirección EVM no válido |
| 403 | `EXPORT_FORBIDDEN` | La exportación no está permitida sin la confirmación adecuada |
| 403 | `TRADE_FORBIDDEN` | Permiso de trade denegado |
| 403 | `STEWARD_POLICY_REJECTED` | El motor de políticas de Steward rechazó la transacción. El cuerpo de la respuesta incluye `execution.policyResults` con detalles sobre qué políticas se evaluaron. |
| 500 | `INSUFFICIENT_BALANCE` | El saldo de la wallet es insuficiente para la operación |
| 500 | `INTERNAL_ERROR` | Error inesperado del servidor |
