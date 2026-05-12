---
title: "Plugin de Tlon"
sidebarTitle: "Tlon"
description: "Conector de Tlon para Eliza — integración de bot con la plataforma de mensajería Tlon (Urbit)."
---

El plugin de Tlon conecta agentes de Eliza a Tlon (Urbit), permitiendo el manejo de mensajes a través de un ship Urbit conectado.

**Package:** `@elizaos/plugin-tlon`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-tlon
```

<div id="setup">

## Configuración

</div>

<div id="1-get-your-urbit-ship-credentials">

### 1. Obtén las credenciales de tu ship Urbit

</div>

1. Ten un ship Urbit en funcionamiento (planet, star o comet)
2. Anota el nombre del ship (por ejemplo, `~zod`)
3. Obtén el código de acceso desde la interfaz web de tu ship (Configuración → Clave de Acceso)
4. Anota la URL del ship (por ejemplo, `http://localhost:8080`)

<div id="2-configure-eliza">

### 2. Configura Eliza

</div>

```json
{
  "connectors": {
    "tlon": {
      "ship": "YOUR_SHIP",
      "code": "YOUR_CODE",
      "url": "YOUR_URL"
    }
  }
}
```

O mediante variables de entorno:

```bash
export TLON_SHIP=YOUR_SHIP
export TLON_CODE=YOUR_CODE
export TLON_URL=YOUR_URL
```

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `ship` | Sí | Nombre del ship Urbit (por ejemplo, `~zod`) |
| `code` | Sí | Código de acceso del ship Urbit |
| `url` | Sí | URL del ship Urbit |
| `enabled` | No | Establecer `false` para deshabilitar (predeterminado: `true`) |

<div id="environment-variables">

## Variables de entorno

</div>

```bash
export TLON_SHIP=YOUR_SHIP
export TLON_CODE=YOUR_CODE
export TLON_URL=YOUR_URL
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
