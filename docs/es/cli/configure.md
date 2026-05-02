---
title: "eliza configure"
sidebarTitle: "configure"
description: "Muestra orientación sobre la configuración y las variables de entorno comunes."
---

Imprime una referencia rápida de configuración en la terminal. El comando `configure` es una guía informativa: muestra cómo leer valores de configuración, qué variables de entorno establecer para los proveedores de modelos y dónde editar el archivo de configuración directamente. No modifica ningún archivo ni configuración.

<div id="usage">

## Uso

</div>

```bash
eliza configure
```

<div id="options">

## Opciones

</div>

`eliza configure` no acepta opciones más allá de las banderas globales estándar.

| Bandera | Descripción |
|------|-------------|
| `-v, --version` | Imprime la versión actual de Eliza y sale |
| `--help`, `-h` | Muestra la ayuda para este comando |
| `--profile <name>` | Usa un perfil de configuración con nombre (el directorio de estado se convierte en `~/.eliza-<name>/`) |
| `--dev` | Atajo para `--profile dev` (también establece el puerto del gateway en `19001`) |
| `--verbose` | Habilita los registros informativos de ejecución |
| `--debug` | Habilita los registros de ejecución a nivel de depuración |
| `--no-color` | Desactiva los colores ANSI |

<div id="example">

## Ejemplo

</div>

```bash
eliza configure
```

<div id="output">

## Salida

</div>

Al ejecutar `eliza configure` se imprime la siguiente información en la terminal:

```
Eliza Configuration

Set values with:
  eliza config get <key>     Read a config value
  Edit ~/.eliza/eliza.json directly for full control.

Common environment variables:
  ANTHROPIC_API_KEY    Anthropic (Claude)
  OPENAI_API_KEY       OpenAI (GPT)
  AI_GATEWAY_API_KEY   Vercel AI Gateway
  GOOGLE_API_KEY       Google (Gemini)
```

<div id="common-environment-variables">

## Variables de entorno comunes

</div>

Las siguientes variables de entorno configuran el acceso a los proveedores de modelos de IA. Establécelas en tu perfil de shell (p. ej. `~/.zshrc` o `~/.bashrc`), en `~/.eliza/.env`, o en un archivo `.env` en tu directorio de trabajo.

| Variable de entorno | Proveedor |
|---------------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway |
| `GOOGLE_API_KEY` | Google (Gemini) |
| `GROQ_API_KEY` | Groq |
| `XAI_API_KEY` | xAI (Grok) |
| `OPENROUTER_API_KEY` | OpenRouter |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `TOGETHER_API_KEY` | Together AI |
| `MISTRAL_API_KEY` | Mistral |
| `COHERE_API_KEY` | Cohere |
| `PERPLEXITY_API_KEY` | Perplexity |
| `OLLAMA_BASE_URL` | Ollama (local, sin clave de API) |

Para una lista completa de proveedores compatibles y sus variables de entorno, consulta [eliza models](/es/cli/models) y [Variables de entorno](/es/cli/environment).

<div id="setting-configuration-values">

## Establecer valores de configuración

</div>

`eliza configure` es de solo lectura. Para cambiar la configuración, usa uno de estos enfoques:

**Leer un valor:**
```bash
eliza config get gateway.port
eliza config get agents.defaults.workspace
```

**Inspeccionar todos los valores:**
```bash
eliza config show
eliza config show --all      # incluir campos avanzados
eliza config show --json     # salida legible por máquina
```

**Encontrar el archivo de configuración:**
```bash
eliza config path
# Output: /Users/you/.eliza/eliza.json
```

**Editar directamente:**
```bash
# Abrir en tu editor
$EDITOR ~/.eliza/eliza.json
```

<div id="related">

## Relacionado

</div>

- [eliza config](/es/cli/config) -- leer e inspeccionar valores de configuración con los subcomandos `get`, `path` y `show`
- [eliza models](/es/cli/models) -- verificar qué proveedores de modelos están configurados
- [eliza setup](/es/cli/setup) -- inicializar el archivo de configuración y el espacio de trabajo
- [Variables de entorno](/es/cli/environment) -- referencia completa de variables de entorno
- [Referencia de configuración](/es/configuration) -- esquema completo del archivo de configuración y todas las opciones disponibles
