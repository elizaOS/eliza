---
title: "Plugin Blooio"
sidebarTitle: "Blooio"
description: "Conector Blooio para Eliza — mensajería iMessage y SMS a través del servicio puente Blooio con webhooks firmados."
---

El plugin Blooio conecta agentes de Eliza a la mensajería iMessage y SMS a través del servicio Blooio. Los mensajes entrantes se entregan mediante webhooks firmados para mayor seguridad.

**Paquete:** `@elizaos/plugin-blooio`

<div id="installation">
## Instalación
</div>

```bash
eliza plugins install @elizaos/plugin-blooio
```

<div id="setup">
## Configuración
</div>

<div id="1-get-blooio-credentials">
### 1. Obtener credenciales de Blooio
</div>

Obtén una clave API de tu cuenta de Blooio.

<div id="2-configure-eliza">
### 2. Configurar Eliza
</div>

```json
{
  "connectors": {
    "blooio": {
      "enabled": true,
      "apiKey": "YOUR_BLOOIO_API_KEY",
      "webhookUrl": "https://your-domain.com/blooio/webhook"
    }
  }
}
```

O usa variables de entorno:

```bash
export BLOOIO_API_KEY=your-blooio-api-key
export BLOOIO_WEBHOOK_URL=https://your-domain.com/blooio/webhook
```

<div id="auto-enable">
## Activación automática
</div>

El plugin se activa automáticamente cuando `apiKey`, `token` o `botToken` está presente en la configuración del conector.

<div id="configuration">
## Configuración
</div>

| Variable | Requerido | Descripción |
|----------|-----------|-------------|
| `apiKey` | Sí | Clave API de la plataforma Blooio |
| `webhookUrl` | No | URL pública para recibir mensajes entrantes |

<div id="features">
## Características
</div>

- Mensajería iMessage y SMS a través del puente Blooio
- Verificación de webhooks firmados para seguridad de mensajes entrantes
- Envío de mensajes salientes
- Gestión de sesiones y enrutamiento de mensajes

<div id="related">
## Relacionado
</div>

- [Plugin iMessage](/es/plugin-registry/platform/imessage) — iMessage nativo de macOS (sin puente necesario)
- [Guía de conectores](/es/guides/connectors#blooio) — Referencia completa de configuración
