---
title: "Plugin de Nextcloud Talk"
sidebarTitle: "Nextcloud Talk"
description: "Conector de Nextcloud Talk para Eliza — integración de bot con el chat de Nextcloud Talk."
---

El plugin de Nextcloud Talk conecta agentes de Eliza a Nextcloud Talk, permitiendo el manejo de mensajes en conversaciones de Nextcloud Talk.

**Package:** `@elizaos/plugin-nextcloud-talk`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-nextcloud-talk
```

<div id="setup">

## Configuración

</div>

<div id="1-configure-your-nextcloud-instance">

### 1. Configura tu instancia de Nextcloud

</div>

1. Asegúrate de que Nextcloud Talk esté instalado y habilitado en tu instancia de Nextcloud
2. Crea un usuario bot o usa una cuenta existente para el agente
3. Anota la URL del servidor Nextcloud y las credenciales

<div id="2-configure-eliza">

### 2. Configura Eliza

</div>

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `connectors.nextcloud-talk` | Sí | Bloque de configuración para Nextcloud Talk |
| `enabled` | No | Establecer `false` para deshabilitar (predeterminado: `true`) |

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
