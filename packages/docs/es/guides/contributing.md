---
title: Guía de contribución
description: Cómo configurar un entorno de desarrollo, seguir las convenciones de código y enviar pull requests al proyecto Eliza.
---

<div id="contributing-guide">
# Guía de contribución
</div>

¡Bienvenido a Eliza! Esta guía te ayudará a configurar tu entorno de desarrollo y contribuir de manera efectiva.

<div id="table-of-contents">
## Tabla de contenidos
</div>

1. [Primeros pasos](#getting-started)
2. [Entorno de desarrollo](#development-environment)
3. [Estructura del proyecto](#project-structure)
4. [Compilación y pruebas](#building-and-testing)
5. [Estilo de código](#code-style)
6. [Proceso de pull request](#pull-request-process)
7. [Comunidad](#community)

---

<div id="getting-started">
## Primeros pasos
</div>

<div id="prerequisites">
### Requisitos previos
</div>

- **Node.js 22 LTS** — Runtime requerido (`.nvmrc` está fijado)
- **Bun** — Gestor de paquetes/runtime usado por los scripts del repositorio
- **Git** — Control de versiones

<div id="quick-setup">
### Configuración rápida
</div>

```bash
# Clone the repository
git clone https://github.com/eliza-ai/eliza.git
cd eliza

# Match repository Node version
nvm use || nvm install
node -v  # expected: v22.22.0

# Install dependencies
bun install

# Build the project
bun run build

# Run in development mode
bun run dev
```

---

<div id="development-environment">
## Entorno de desarrollo
</div>

<div id="required-tools">
### Herramientas requeridas
</div>

| Herramienta | Versión | Propósito |
|-------------|---------|-----------|
| Node.js | 22.x LTS | Runtime |
| Bun | Última | Gestión de paquetes + ejecutor de scripts |
| Git | Última | Control de versiones |

<div id="optional-tools">
### Herramientas opcionales
</div>

| Herramienta | Propósito |
|-------------|-----------|
| bun | Gestor de paquetes opcional para flujos fuera del repositorio |
| Docker | Pruebas en contenedores |
| VS Code | Editor recomendado |

<div id="editor-setup">
### Configuración del editor
</div>

**Extensiones de VS Code:**
- ESLint
- Prettier
- TypeScript
- Biome (para formateo)

**Configuración (.vscode/settings.json):**
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome",
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

---

<div id="monorepo-structure">
## Estructura del monorepo
</div>

Eliza es un monorepo gestionado con Turborepo y workspaces de Bun.

```
eliza/
├── packages/                # Shared packages
│   ├── typescript/          # @elizaos/core — Core TypeScript SDK
│   ├── elizaos/             # CLI tool (eliza command)
│   ├── skills/              # Skills system and bundled skills
│   ├── docs/                # Documentation site (Mintlify)
│   ├── schemas/             # Protobuf schemas
│   └── tui/                 # Terminal UI (disabled)
├── plugins/                 # Official plugins (100+)
│   ├── plugin-anthropic/    # Anthropic model provider
│   ├── plugin-telegram/     # Telegram connector
│   ├── plugin-discord/      # Discord connector
│   └── ...
├── apps/
│   ├── app/                 # Desktop/mobile app (Capacitor + React)
│   └── ...                  # No shipped chrome-extension app in this release checkout
├── src/                     # Eliza runtime
│   ├── runtime/             # elizaOS runtime bootstrap
│   ├── plugins/             # Built-in Eliza plugins
│   ├── config/              # Configuration loading
│   ├── services/            # Registry client, plugin manager
│   └── api/                 # REST API server
├── skills/                  # Workspace skills
├── docs/                    # Documentation (this site)
├── scripts/                 # Build and utility scripts
├── test/                    # Test setup, helpers, e2e
├── AGENTS.md                # Repository guidelines
├── plugins.json             # Plugin registry manifest
└── tsdown.config.ts         # Build config
```

<div id="turbo-build-system">
### Sistema de compilación Turbo
</div>

Turborepo orquesta las compilaciones en todos los paquetes con caché basada en dependencias:

```bash
# Build everything (with caching)
turbo run build

# Build a specific package
turbo run build --filter=@elizaos/core

# Build a package and all its dependencies
turbo run build --filter=@elizaos/plugin-telegram...

# Run tests across all packages
turbo run test

# Lint all packages
turbo run lint
```

<div id="key-entry-points">
### Puntos de entrada clave
</div>

| Archivo | Propósito |
|---------|-----------|
| `src/entry.ts` | Punto de entrada CLI |
| `src/index.ts` | Exportaciones de librería |
| `src/runtime/eliza.ts` | Inicialización del runtime elizaOS |
| `src/runtime/eliza-plugin.ts` | Plugin principal de Eliza |
| `eliza.mjs` | Entrada bin de npm |

---

<div id="building-and-testing">
## Compilación y pruebas
</div>

<div id="build-commands">
### Comandos de compilación
</div>

```bash
# Full build (TypeScript + UI)
bun run build

# TypeScript only
bun run build

# Desktop app (Electrobun)
bun run build:desktop

# Mobile (Android)
bun run build:android

# Mobile (iOS)
bun run build:ios
```

<div id="development-mode">
### Modo de desarrollo
</div>

```bash
# Run with auto-reload on changes
bun run dev

# Run CLI directly (via tsx)
bun run eliza start

# UI development only
bun run dev:ui

# Desktop app development
bun run dev:desktop
```

<div id="testing">
### Pruebas
</div>

Los umbrales de cobertura se aplican desde `scripts/coverage-policy.mjs`: 25% de líneas/funciones/declaraciones, 15% de ramas. CI falla cuando la cobertura cae por debajo de estos mínimos.

```bash
# Run all tests (parallel)
bun run test

# Run with coverage (enforces thresholds)
bun run test:coverage

# Watch mode
bun run test:watch

# End-to-end tests
bun run test:e2e

# Live tests (requires API keys)
ELIZA_LIVE_TEST=1 bun run test:live

# Docker-based tests
bun run test:docker:all
```

<div id="runtime-fallback-for-bun-crashes">
### Fallback de runtime para crashes de Bun
</div>

Si Bun falla con segfault en tu plataforma durante sesiones largas, ejecuta Eliza en runtime de Node:

```bash
ELIZA_RUNTIME=node bun run eliza start
```

<div id="test-file-conventions">
### Convenciones de archivos de prueba
</div>

| Patrón | Propósito |
|--------|-----------|
| `*.test.ts` | Pruebas unitarias (colocadas junto al código fuente) |
| `*.e2e.test.ts` | Pruebas end-to-end |
| `*.live.test.ts` | Pruebas de API en vivo |
| `test/**/*.test.ts` | Pruebas de integración |

<div id="packagesapp-core-in-the-root-vitest-config">
### `packages/app-core` en la configuración raíz de Vitest
</div>

El **`vitest.config.ts`** en la raíz del repositorio (usado por **`bun run test`** → shard unitario) incluye:

- **`packages/app-core/src/**/*.test.ts`** y **`packages/app-core/src/**/*.test.tsx`** — pruebas colocadas, incluyendo TSX, sin listar cada archivo.
- **`packages/app-core/test/**/*.test.ts`** y **`.../test/**/*.test.tsx`** — pruebas de arnés compartido (por ejemplo, `test/state`, `test/runtime`).

**Por qué:** esos directorios estaban previamente omitidos, por lo que las nuevas suites nunca se ejecutaban en CI. **`packages/app-core/test/**/*.e2e.test.ts(x)`** se excluye de este job para que e2e permanezca en **`test/vitest/e2e.config.ts`**. **`test/vitest/unit.config.ts`** aún omite **`packages/app-core/test/app/**`** (arnés de renderizador pesado) del pase unitario enfocado en cobertura — **por qué:** esos se ejecutan en workspaces de app específicos o jobs separados.

---

<div id="code-style">
## Estilo de código
</div>

<div id="typescript-guidelines">
### Directrices de TypeScript
</div>

- **Modo estricto** — Usa siempre TypeScript estricto
- **Evita `any`** — Usa tipos apropiados o `unknown`
- **ESM** — Usa módulos ES (`import`/`export`)
- **Async/await** — Preferido sobre promesas sin procesar

<div id="naming-conventions">
### Convenciones de nomenclatura
</div>

| Elemento | Convención | Ejemplo |
|----------|------------|---------|
| Archivos | kebab-case | `my-feature.ts` |
| Clases | PascalCase | `MyService` |
| Funciones | camelCase | `processMessage` |
| Constantes | UPPER_SNAKE | `MAX_RETRIES` |
| Acciones | UPPER_SNAKE | `RESTART_AGENT` |
| Tipos/Interfaces | PascalCase | `PluginConfig` |

<div id="product-vs-code-naming">
### Nombres de producto vs código
</div>

- **Eliza** — Nombre del producto, encabezados, documentación
- **eliza** — Comando CLI, nombre de paquete, rutas, claves de configuración

<div id="formatting">
### Formateo
</div>

El proyecto usa **Biome** para formateo y linting:

```bash
# Check formatting and lint
bun run check

# Fix formatting issues
bun run format:fix

# Fix lint issues
bun run lint:fix
```

<div id="file-size">
### Tamaño de archivo
</div>

Intenta mantener los archivos por debajo de **~500 líneas**. Divide cuando mejore:
- Claridad
- Testabilidad
- Reutilización

<div id="comments">
### Comentarios
</div>

```typescript
// ✅ Explain WHY, not WHAT
// Rate limit to avoid API throttling during batch operations
const BATCH_DELAY_MS = 100;

// ❌ Don't explain obvious code
// Increment counter by 1
counter++;
```

<div id="error-handling">
### Manejo de errores
</div>

```typescript
// ✅ Specific error types with context
throw new Error(`Failed to load plugin "${name}": ${err.message}`);

// ✅ Graceful degradation
try {
  await riskyOperation();
} catch (err) {
  runtime.logger?.warn({ err, context }, "Operation failed, using fallback");
  return fallbackValue;
}

// ❌ Silent swallowing
try {
  await something();
} catch {}
```

---

<div id="pull-request-process">
## Proceso de pull request
</div>

<div id="branch-strategy">
### Estrategia de ramas
</div>

| Rama | Propósito | Publica en |
|------|-----------|------------|
| `develop` | Desarrollo activo, los PRs se fusionan aquí | Releases alfa |
| `main` | Releases estables | Releases beta |
| GitHub Releases | Versiones etiquetadas | Producción (npm, PyPI, Snap, APT, Homebrew) |
| `feature/*` | Nuevas funcionalidades | — |
| `fix/*` | Correcciones de errores | — |

<div id="creating-a-pr">
### Crear un PR
</div>

1. **Fork y clone** (o rama desde develop)
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```

2. **Haz cambios** con commits significativos
   ```bash
   git add .
   git commit -m "feat: add new action for X"
   ```

3. **Ejecuta verificaciones antes de push**
   ```bash
   bun run check
   bun run test
   ```

4. **Push y crea PR**
   ```bash
   git push origin feature/my-feature
   # Then open PR on GitHub
   ```

<div id="commit-message-format">
### Formato de mensajes de commit
</div>

Usa commits convencionales:

```
<type>: <description>

[optional body]

[optional footer]
```

**Tipos:**
- `feat:` — Nueva funcionalidad
- `fix:` — Corrección de error
- `docs:` — Documentación
- `refactor:` — Refactorización de código
- `test:` — Adiciones/cambios de pruebas
- `chore:` — Build, deps, configs

**Ejemplos:**
```
feat: add voice message support to telegram connector

fix: prevent crash when config file is missing

docs: add plugin development guide

refactor: extract session key logic to provider

chore: update @elizaos/core to 2.0.0-alpha.4
```

<div id="pr-checklist">
### Checklist del PR
</div>

Antes de enviar:

- [ ] El código compila sin errores (`bun run build`)
- [ ] Las pruebas pasan (`bun run test`)
- [ ] El linting pasa (`bun run check`)
- [ ] El código nuevo tiene pruebas (si aplica)
- [ ] La documentación está actualizada (si aplica)
- [ ] Los mensajes de commit siguen las convenciones
- [ ] La descripción del PR explica el cambio

<div id="code-review">
### Revisión de código
</div>

Los PRs son revisados por los mantenedores. Espera feedback sobre:

- **Corrección** — ¿Funciona?
- **Diseño** — ¿El enfoque es sólido?
- **Estilo** — ¿Sigue las convenciones?
- **Pruebas** — ¿Está adecuadamente probado?
- **Documentación** — ¿Está documentado?

Claude Code Review está habilitado para feedback inicial automatizado.

---

<div id="community">
## Comunidad
</div>

<div id="discord">
### Discord
</div>

Únete al Discord de la comunidad para ayuda, discusiones y anuncios:

**[discord.gg/ai16z](https://discord.gg/ai16z)**

Canales:
- `#eliza` — Discusión específica de Eliza
- `#dev` — Ayuda de desarrollo
- `#showcase` — Comparte lo que has construido

<div id="github">
### GitHub
</div>

- **Issues** — Reportes de errores, solicitudes de funcionalidades
- **Discussions** — Preguntas, ideas, RFC
- **PRs** — Contribuciones de código

<div id="reporting-issues">
### Reportar problemas
</div>

Al crear un issue:

1. **Verifica los issues existentes** — Evita duplicados
2. **Usa las plantillas** — Completa la plantilla proporcionada
3. **Incluye reproducción** — Pasos para reproducir
4. **Comparte logs** — Salida de errores relevante
5. **Entorno** — SO, versión de Node, versión de Eliza

```markdown
## Bug Report

**Describe the bug:**
Brief description

**To reproduce:**
1. Run `eliza start`
2. Send message "..."
3. Error occurs

**Expected behavior:**
What should happen

**Environment:**
- OS: macOS 14.2
- Node: 22.12.0
- Eliza: 2.0.0-alpha.8

**Logs:**
```
[error output here]
```
```

---

<div id="getting-help">
## Obtener ayuda
</div>

- **Discord** — Respuesta más rápida para preguntas
- **GitHub Issues** — Reportes de errores y funcionalidades
- **Documentación** — Consulta `/docs` primero
- **AGENTS.md** — Directrices específicas del repositorio

---

<div id="next-steps">
## Próximos pasos
</div>

- [Guía de desarrollo de plugins](/es/plugins/development) — Crear plugins
- [Documentación de skills](/es/plugins/skills) — Crear skills
- [Desarrollo local de plugins](/es/plugins/local-plugins) — Desarrollar localmente
- Explora el código: empieza con `src/runtime/eliza-plugin.ts`
