---
title: "Plugin de OpenAI"
sidebarTitle: "OpenAI"
description: "Proveedor de modelos OpenAI para Eliza — GPT-4o, o1, o3, embeddings, generación de imágenes y voz."
---

El plugin de OpenAI conecta los agentes de Eliza con la API de OpenAI, proporcionando acceso a GPT-4o, las familias de modelos de razonamiento o1/o3, generación de imágenes DALL-E y conversión de voz a texto con Whisper.

**Package:** `@elizaos/plugin-openai`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-openai
```

O añade a `eliza.json`:

```json
{
  "plugins": {
    "allow": ["openai"]
  }
}
```

<div id="auto-enable">

## Activación automática

</div>

El plugin se activa automáticamente cuando `OPENAI_API_KEY` está presente en el entorno:

```bash
export OPENAI_API_KEY=sk-...
```

<div id="configuration">

## Configuración

</div>

| Variable de entorno | Requerido | Descripción |
|---------------------|-----------|-------------|
| `OPENAI_API_KEY` | Sí | Clave API de OpenAI desde [platform.openai.com](https://platform.openai.com) |
| `OPENAI_API_URL` | No | URL base personalizada (para Azure OpenAI o APIs compatibles) |
| `OPENAI_ORG_ID` | No | ID de organización para seguimiento de uso |
| `OPENAI_PROJECT_ID` | No | ID de proyecto para gestión de cuotas |

<div id="elizajson-example">

### Ejemplo de eliza.json

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openai",
        "model": "gpt-4o"
      }
    }
  }
}
```

<div id="supported-models">

## Modelos compatibles

</div>

<div id="text-generation">

### Generación de texto

</div>

| Modelo | Contexto | Mejor para |
|--------|----------|------------|
| `gpt-5.5` | 1M | Último modelo principal |
| `gpt-5-mini` | 1M | Tareas rápidas y económicas |
| `gpt-5.5-nano` | 1M | Ultra rápido, menor costo |
| `gpt-4o` | 128k | Razonamiento multimodal |
| `gpt-5-mini` | 128k | Tareas multimodales rápidas |

<div id="reasoning-models">

### Modelos de razonamiento

</div>

| Modelo | Contexto | Mejor para |
|--------|----------|------------|
| `o1` | 200k | Tareas de razonamiento profundo |
| `o1-mini` | 128k | Razonamiento rápido |
| `o3` | 200k | Razonamiento de última generación |
| `o3-mini` | 200k | Razonamiento eficiente |
| `o4-mini` | 200k | Último razonamiento eficiente |

<div id="other-capabilities">

### Otras capacidades

</div>

| Capacidad | Modelo |
|-----------|--------|
| Embeddings | `text-embedding-3-small`, `text-embedding-3-large` |
| Generación de imágenes | `dall-e-3`, `dall-e-2` |
| Voz a texto | `whisper-1` |
| Texto a voz | `tts-1`, `tts-1-hd` |
| Visión | `gpt-4o` (multimodal) |

<div id="model-type-mapping">

## Mapeo de tipos de modelo

</div>

| Tipo de modelo elizaOS | Modelo OpenAI |
|------------------------|--------------|
| `TEXT_SMALL` | `gpt-5-mini` |
| `TEXT_LARGE` | `gpt-4o` |
| `TEXT_EMBEDDING` | `text-embedding-3-small` |
| `IMAGE` | `dall-e-3` |
| `TRANSCRIPTION` | `whisper-1` |
| `TEXT_TO_SPEECH` | `tts-1` |

<div id="features">

## Características

</div>

- Respuestas en streaming
- Llamada a funciones/herramientas
- Visión (entrada de imágenes con `gpt-4o`)
- Salida JSON estructurada (`response_format: { type: "json_object" }`)
- Soporte de API por lotes
- Seguimiento de uso de tokens

<div id="usage-example">

## Ejemplo de uso

</div>

```typescript
// In a plugin or action handler:
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Explain quantum entanglement in simple terms.",
  maxTokens: 500,
  temperature: 0.7,
});
```

<div id="rate-limits-and-pricing">

## Límites de tasa y precios

</div>

Los límites de tasa dependen de tu nivel de uso en OpenAI. Consulta [platform.openai.com/docs/guides/rate-limits](https://platform.openai.com/docs/guides/rate-limits) para los límites actuales por nivel.

Precios: [openai.com/pricing](https://openai.com/pricing)

<div id="related">

## Relacionado

</div>

- [Plugin de Anthropic](/es/plugin-registry/llm/anthropic) — Familia de modelos Claude
- [Plugin de OpenRouter](/es/plugin-registry/llm/openrouter) — Enrutamiento entre proveedores
- [Proveedores de modelos](/es/runtime/models) — Comparar todos los proveedores
