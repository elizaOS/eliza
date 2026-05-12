---
title: "Plugin de Anthropic"
sidebarTitle: "Anthropic"
description: "Proveedor de modelos Anthropic Claude para Eliza — Claude Opus 4.7, Sonnet 4.6, Haiku 4.5 y soporte de pensamiento adaptativo."
---

El plugin de Anthropic conecta los agentes de Eliza con la API de Claude de Anthropic y expone los modelos actuales Claude Opus 4.7, Claude Sonnet 4.6 y Claude Haiku 4.5.

**Package:** `@elizaos/plugin-anthropic`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-anthropic
```

<div id="auto-enable">

## Activación automática

</div>

El plugin se activa automáticamente cuando `ANTHROPIC_API_KEY` o `CLAUDE_API_KEY` está presente:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

<div id="configuration">

## Configuración

</div>

| Variable de entorno | Requerido | Descripción |
|---------------------|-----------|-------------|
| `ANTHROPIC_API_KEY` | Sí* | Clave API de Anthropic desde [console.anthropic.com](https://console.anthropic.com) |
| `CLAUDE_API_KEY` | Sí* | Alias de `ANTHROPIC_API_KEY` |
| `ANTHROPIC_API_URL` | No | URL base personalizada |

*Se requiere `ANTHROPIC_API_KEY` o `CLAUDE_API_KEY`.

<div id="elizajson-example">

### Ejemplo de eliza.json

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
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
| `claude-opus-4-7` | 200k | El modelo más capaz para razonamiento complejo y agentes de larga duración |
| `claude-sonnet-4-6` | 200k | Modelo grande predeterminado para código, análisis y uso general |
| `claude-haiku-4-5-20251001` | 200k | Tareas rápidas y ligeras |

<div id="model-type-mapping">

## Mapeo de tipos de modelo

</div>

| Tipo de modelo elizaOS | Modelo Anthropic |
|------------------------|-----------------|
| `TEXT_SMALL` | `claude-haiku-4-5-20251001` |
| `TEXT_LARGE` | `claude-sonnet-4-6` |

<div id="features">

## Características

</div>

- Respuestas en streaming
- Uso de herramientas (llamada a funciones)
- Visión (entrada de imágenes en todos los modelos)
- Pensamiento adaptativo/extendido en `claude-sonnet-4-6` y `claude-opus-4-7`
- Salida JSON estructurada mediante uso de herramientas
- Ventana de contexto de 200k tokens en todos los modelos
- Caché de prompts para reducir costos en contexto repetido

<div id="extended-thinking">

## Pensamiento extendido

</div>

Claude Sonnet 4.6 y Claude Opus 4.7 admiten los modos adaptativo/extendido de Anthropic para razonamiento complejo y planificación de varios pasos.

```typescript
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Design a database schema for a multi-tenant SaaS application.",
  thinking: { type: "enabled", budgetTokens: 10000 },
});
```

<div id="rate-limits-and-pricing">

## Límites de tasa y precios

</div>

Los límites dependen de tu nivel de uso en Anthropic. Consulta [docs.anthropic.com/en/api/rate-limits](https://docs.anthropic.com/en/api/rate-limits) para los límites actuales.

Precios: [anthropic.com/pricing](https://www.anthropic.com/pricing)

<div id="related">

## Relacionado

</div>

- [Plugin de OpenAI](/es/plugin-registry/llm/openai) — GPT-4o y modelos de razonamiento
- [Plugin de OpenRouter](/es/plugin-registry/llm/openrouter) — Enrutamiento entre proveedores, incluido Anthropic
- [Proveedores de modelos](/es/runtime/models) — Comparar todos los proveedores
