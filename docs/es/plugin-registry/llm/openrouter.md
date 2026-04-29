---
title: "Plugin de OpenRouter"
sidebarTitle: "OpenRouter"
description: "Pasarela multi-proveedor OpenRouter para Milady — accede a más de 200 modelos de OpenAI, Anthropic, Google, Meta y otros a través de una única API."
---

El plugin de OpenRouter conecta los agentes de Milady con la pasarela de inferencia unificada de OpenRouter, proporcionando acceso a más de 200 modelos de todos los proveedores principales a través de una única clave API y punto de acceso.

**Package:** `@elizaos/plugin-openrouter`

<div id="milady-pinned-version-and-upstream-bundle-bug">

## Milady: versión fijada y error en el bundle upstream

</div>

En el monorepo de Milady, **`@elizaos/plugin-openrouter` está fijado en `2.0.0-alpha.13`** (versión exacta en el `package.json` raíz, reflejado en `bun.lock`).

**Por qué se fija**

- **`2.0.0-alpha.12` en npm es una publicación defectuosa:** los bundles ESM de Node y navegador están **truncados**. Solo incluyen helpers de configuración empaquetados; el **objeto principal del plugin falta**, pero el archivo aún **exporta** `openrouterPlugin` y un alias por defecto. **Por qué falla en tiempo de ejecución:** Bun (y cualquier herramienta estricta) intenta cargar ese archivo y falla porque esas vinculaciones **nunca se declaran** en el módulo.
- **Por qué no `^2.0.0-alpha.10`:** Los rangos de semver pueden flotar hasta **`alpha.12`**, lo que rompe `bun install` / la actualización del lockfile para todos los que usan OpenRouter.
- **Por qué no parcheamos esto en `patch-deps.mjs`:** A diferencia de un *nombre* de exportación incorrecto en un archivo por lo demás completo, este tarball omite el **fragmento de implementación completo**. Un reemplazo de cadena en postinstall no puede inventar el plugin; la corrección segura es **usar una versión funcional**.

**Cuándo eliminar la fijación**

Después de que upstream publique una versión corregida, verifica que `dist/node/index.node.js` contenga el plugin completo (cientos de líneas, no ~80) y que `bun build …/index.node.js --target=bun` tenga éxito, luego actualiza y relaja el rango si lo deseas.

**Referencia:** [Resolución de plugins — OpenRouter fijado](/es/plugin-resolution-and-node-path#pinned-elizaosplugin-openrouter).

<div id="installation">

## Instalación

</div>

```bash
milady plugins install @elizaos/plugin-openrouter
```

<div id="auto-enable">

## Activación automática

</div>

El plugin se activa automáticamente cuando `OPENROUTER_API_KEY` está presente:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

<div id="configuration">

## Configuración

</div>

| Variable de entorno | Requerido | Descripción |
|---------------------|-----------|-------------|
| `OPENROUTER_API_KEY` | Sí | Clave API de OpenRouter desde [openrouter.ai](https://openrouter.ai) |

<div id="miladyjson-example">

### Ejemplo de milady.json

</div>

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.6"
      }
    }
  }
}
```

<div id="supported-models">

## Modelos compatibles

</div>

OpenRouter proporciona acceso a modelos de todos los proveedores principales. Usa el ID de modelo completo con prefijo del proveedor:

<div id="openai-via-openrouter">

### OpenAI a través de OpenRouter

</div>

| ID del modelo | Descripción |
|---------------|-------------|
| `openai/gpt-4o` | GPT-4o multimodal |
| `openai/gpt-4o-mini` | Rápido y eficiente |
| `openai/o1` | Modelo de razonamiento |
| `openai/o3-mini` | Razonamiento rápido |

<div id="anthropic-via-openrouter">

### Anthropic a través de OpenRouter

</div>

| ID del modelo | Descripción |
|---------------|-------------|
| `anthropic/claude-opus-4.7` | Claude más capaz |
| `anthropic/claude-sonnet-4.6` | Claude equilibrado |
| `anthropic/claude-haiku-4.5` | Claude más rápido |

<div id="meta-via-openrouter">

### Meta a través de OpenRouter

</div>

| ID del modelo | Descripción |
|---------------|-------------|
| `meta-llama/llama-3.3-70b-instruct` | Llama 3.3 70B |
| `meta-llama/llama-3.1-405b-instruct` | Llama 3.1 405B |

<div id="google-via-openrouter">

### Google a través de OpenRouter

</div>

| ID del modelo | Descripción |
|---------------|-------------|
| `google/gemini-2.5-pro` | Gemini 2.5 Pro |
| `google/gemini-2.5-flash` | Gemini 2.5 Flash |

Explora todos los modelos en [openrouter.ai/models](https://openrouter.ai/models).

<div id="model-type-mapping">

## Mapeo de tipos de modelo

</div>

| Tipo de modelo elizaOS | Modelo OpenRouter predeterminado |
|------------------------|--------------------------------|
| `TEXT_SMALL` | `anthropic/claude-haiku-4.5` |
| `TEXT_LARGE` | `anthropic/claude-sonnet-4.6` |

<div id="features">

## Características

</div>

- Una única clave API para más de 200 modelos
- Respaldo automático a proveedores alternativos cuando el principal no está disponible
- Optimización de costos — enruta al proveedor más económico disponible
- Comparación de modelos y pruebas A/B
- Panel de análisis de uso
- Respuestas en streaming
- Formato de API compatible con OpenAI
- Modelos gratuitos disponibles (nivel comunitario)

<div id="provider-routing">

## Enrutamiento de proveedores

</div>

OpenRouter admite preferencias de enrutamiento por costo, latencia o rendimiento:

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.6",
        "providerPreferences": {
          "order": ["Anthropic", "AWS Bedrock"],
          "allowFallbacks": true
        }
      }
    }
  }
}
```

<div id="free-models">

## Modelos gratuitos

</div>

OpenRouter ofrece acceso gratuito a una selección de modelos de código abierto (con límite de tasa):

- `meta-llama/llama-3.2-3b-instruct:free`
- `google/gemma-2-9b-it:free`
- `mistralai/mistral-7b-instruct:free`

<div id="rate-limits-and-pricing">

## Límites de tasa y precios

</div>

Los precios son por modelo y varían según el proveedor. OpenRouter cobra las mismas tarifas que el proveedor subyacente más un pequeño margen en algunos modelos.

Consulta [openrouter.ai/docs#limits](https://openrouter.ai/docs#limits) para detalles sobre los límites de tasa.

<div id="related">

## Relacionado

</div>

- [Plugin de OpenAI](/es/plugin-registry/llm/openai) — Integración directa con OpenAI
- [Plugin de Anthropic](/es/plugin-registry/llm/anthropic) — Integración directa con Anthropic
- [Proveedores de modelos](/es/runtime/models) — Comparar todos los proveedores
