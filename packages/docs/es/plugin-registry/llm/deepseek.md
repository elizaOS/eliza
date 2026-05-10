---
title: "Plugin de DeepSeek"
sidebarTitle: "DeepSeek"
description: "Proveedor de modelos DeepSeek para Eliza — modelos DeepSeek-V3 y DeepSeek-R1 de razonamiento."
---

El plugin de DeepSeek conecta los agentes de Eliza con la API de DeepSeek, proporcionando acceso a los modelos DeepSeek-V3 (propósito general) y DeepSeek-R1 (enfocado en razonamiento) a precios competitivos.

**Package:** `@elizaos/plugin-deepseek`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-deepseek
```

<div id="auto-enable">

## Activación automática

</div>

El plugin se activa automáticamente cuando `DEEPSEEK_API_KEY` está presente:

```bash
export DEEPSEEK_API_KEY=sk-...
```

<div id="configuration">

## Configuración

</div>

| Variable de entorno | Requerido | Descripción |
|---------------------|-----------|-------------|
| `DEEPSEEK_API_KEY` | Sí | Clave API de DeepSeek desde [platform.deepseek.com](https://platform.deepseek.com) |
| `DEEPSEEK_API_URL` | No | URL base personalizada (predeterminado: `https://api.deepseek.com`) |

<div id="elizajson-example">

### Ejemplo de eliza.json

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "deepseek",
        "model": "deepseek-chat"
      }
    }
  }
}
```

<div id="supported-models">

## Modelos compatibles

</div>

| Modelo | Contexto | Mejor para |
|--------|----------|------------|
| `deepseek-chat` | 64k | Chat de propósito general (DeepSeek-V3) |
| `deepseek-reasoner` | 64k | Razonamiento con cadena de pensamiento (DeepSeek-R1) |

DeepSeek-V3 es un modelo de mezcla de expertos con 671B parámetros (37B activos). DeepSeek-R1 es un modelo de razonamiento entrenado con aprendizaje por refuerzo.

<div id="model-type-mapping">

## Mapeo de tipos de modelo

</div>

| Tipo de modelo elizaOS | Modelo DeepSeek |
|------------------------|----------------|
| `TEXT_SMALL` | `deepseek-chat` |
| `TEXT_LARGE` | `deepseek-chat` o `deepseek-reasoner` (configura el slot grande) |

<div id="features">

## Características

</div>

- Formato de API compatible con OpenAI
- Respuestas en streaming
- Llamada a funciones / uso de herramientas
- Conversación multi-turno
- Generación de código (herencia de DeepSeek-Coder en V3)
- Razonamiento con cadena de pensamiento (R1)
- Precios competitivos — significativamente más económico que modelos occidentales comparables

<div id="deepseek-r1-reasoning">

## Razonamiento DeepSeek-R1

</div>

El modelo `deepseek-reasoner` produce un bloque `<think>` que contiene su cadena de razonamiento antes de la respuesta final. Configura el slot de texto **grande** a `deepseek-reasoner`, luego usa `TEXT_LARGE`:

```typescript
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Prove that there are infinitely many prime numbers.",
});
```

<div id="local-deepseek-via-ollama">

## DeepSeek local con Ollama

</div>

Para inferencia local, configura el [plugin de Ollama](/es/plugin-registry/llm/ollama)
con Eliza-1 en lugar de enrutar DeepSeek a través de un servidor local.

<div id="rate-limits-and-pricing">

## Límites de tasa y precios

</div>

DeepSeek ofrece precios competitivos por token. Consulta [platform.deepseek.com/docs/pricing](https://platform.deepseek.com/docs/pricing) para las tarifas actuales.

DeepSeek-V3 cuesta una fracción de GPT-4o con calidad comparable para la mayoría de las tareas.

<div id="related">

## Relacionado

</div>

- [Plugin de OpenRouter](/es/plugin-registry/llm/openrouter) — Accede a DeepSeek a través de OpenRouter
- [Plugin de Groq](/es/plugin-registry/llm/groq) — Alternativa de inferencia rápida
- [Plugin de Ollama](/es/plugin-registry/llm/ollama) — Ejecuta DeepSeek localmente
- [Proveedores de modelos](/es/runtime/models) — Comparar todos los proveedores
