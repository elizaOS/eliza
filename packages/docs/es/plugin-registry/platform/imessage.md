---
title: "Plugin iMessage"
sidebarTitle: "iMessage"
description: "Conector iMessage para Eliza — mensajería nativa de macOS con soporte de iMessage y SMS, acceso a base de datos y conectividad con host remoto."
---

El plugin iMessage conecta agentes de Eliza a iMessage en macOS, soportando tanto conversaciones de iMessage como SMS con selección de servicio configurable y manejo de adjuntos.

**Paquete:** `@elizaos/plugin-imessage`

<div id="installation">
## Instalación
</div>

```bash
eliza plugins install @elizaos/plugin-imessage
```

<div id="setup">
## Configuración
</div>

<div id="1-prerequisites">
### 1. Requisitos previos
</div>

- macOS con iMessage configurado e iniciado sesión
- Acceso completo al disco otorgado a la terminal o aplicación que ejecuta Eliza (para acceso a la base de datos de chat)

<div id="2-configure-eliza">
### 2. Configurar Eliza
</div>

```json
{
  "connectors": {
    "imessage": {
      "enabled": true,
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="configuration">
## Configuración
</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `service` | No | Tipo de servicio: `imessage`, `sms` o `auto` (predeterminado: `auto`) |
| `cliPath` | No | Ruta a la herramienta CLI de iMessage |
| `dbPath` | No | Ruta a la base de datos de iMessage |
| `remoteHost` | No | Host remoto para acceso vía SSH |
| `region` | No | Configuración de región |
| `includeAttachments` | No | Incluir adjuntos en los mensajes (predeterminado: `true`) |
| `dmPolicy` | No | Política de manejo de DMs |

<div id="features">
## Características
</div>

- **Selección de servicio** — Elige entre iMessage, SMS o detección automática
- **Acceso a base de datos** — Acceso directo a la base de datos de iMessage de macOS para historial de mensajes
- **Host remoto** — Conéctate a iMessage en un Mac remoto vía SSH
- **Adjuntos** — Envía y recibe adjuntos multimedia
- **Configuración por grupo** — Configura requisitos de mención y acceso a herramientas por grupo
- **Multi-cuenta** — Soporta múltiples cuentas mediante el mapa `accounts`

<div id="auto-enable">
## Activación automática
</div>

El plugin se activa automáticamente cuando el bloque `connectors.imessage` está presente:

```json
{
  "connectors": {
    "imessage": {
      "enabled": true
    }
  }
}
```

<div id="troubleshooting">
## Solución de problemas
</div>

<div id="full-disk-access">
### Acceso completo al disco
</div>

Si la recuperación de mensajes falla, asegúrate de que el Acceso completo al disco esté otorgado:

1. Abre **Ajustes del Sistema → Privacidad y Seguridad → Acceso completo al disco**
2. Agrega la aplicación de terminal o el proceso de Eliza

<div id="database-path">
### Ruta de la base de datos
</div>

La base de datos predeterminada de iMessage está en `~/Library/Messages/chat.db`. Si usas una ubicación no estándar, establece `dbPath` explícitamente.

<div id="related">
## Relacionado
</div>

- [Plugin Signal](/es/plugin-registry/platform/signal) — Integración de mensajería Signal
- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
