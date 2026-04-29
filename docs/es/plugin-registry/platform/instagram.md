---
title: "Plugin de Instagram"
sidebarTitle: "Instagram"
description: "Conector de Instagram para Milady — interactúa con la mensajería y el contenido de Instagram."
---

El plugin de Instagram conecta agentes de Milady a Instagram, permitiendo el manejo de mensajes e interacciones de contenido.

**Package:** `@elizaos/plugin-instagram`

<div id="installation">

## Instalación

</div>

```bash
milady plugins install @elizaos/plugin-instagram
```

<div id="setup">

## Configuración

</div>

<div id="1-get-your-instagram-credentials">

### 1. Obtén tus credenciales de Instagram

</div>

1. Usa tu nombre de usuario y contraseña de cuenta de Instagram
2. Para automatización, considera crear una cuenta dedicada para tu agente

<div id="2-configure-milady">

### 2. Configura Milady

</div>

```json
{
  "connectors": {
    "instagram": {
      "username": "YOUR_USERNAME",
      "password": "YOUR_PASSWORD"
    }
  }
}
```

O mediante variables de entorno:

```bash
export INSTAGRAM_USERNAME=YOUR_USERNAME
export INSTAGRAM_PASSWORD=YOUR_PASSWORD
```

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `username` | Sí | Nombre de usuario de la cuenta de Instagram |
| `password` | Sí | Contraseña de la cuenta de Instagram |
| `enabled` | No | Establecer `false` para deshabilitar (predeterminado: `true`) |

<div id="environment-variables">

## Variables de entorno

</div>

```bash
export INSTAGRAM_USERNAME=YOUR_USERNAME
export INSTAGRAM_PASSWORD=YOUR_PASSWORD
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
