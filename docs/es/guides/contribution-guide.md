---
title: "Guía de contribución"
sidebarTitle: "Contribución"
description: "Configura tu entorno de desarrollo y contribuye a Milady."
---

Bienvenido al proyecto Milady. Esta guía cubre la configuración del entorno, el flujo de trabajo de desarrollo y el proceso de pull request.

Antes de contribuir, lee [CONTRIBUTING.md](https://github.com/milady-ai/milady/blob/develop/CONTRIBUTING.md) en la raíz del repositorio para conocer la filosofía de contribución del proyecto. Milady es un **código base solo de agentes** -- cada PR es revisado y fusionado por agentes de IA, no por mantenedores humanos. Los humanos contribuyen principalmente como testers de QA y reporteros de bugs.

---

<div id="prerequisites">
## Requisitos previos
</div>

| Herramienta | Versión | Propósito |
|-------------|---------|-----------|
| [Node.js](https://nodejs.org/) | >= 22 | Runtime (requerido por el campo `engines`) |
| [Bun](https://bun.sh/) | Última | Gestor de paquetes y ejecutor de scripts |
| [Git](https://git-scm.com/) | Última | Control de versiones |

Bun es el gestor de paquetes del proyecto. Todos los comandos de esta guía usan `bun`.

---

<div id="setup">
## Configuración
</div>

```bash
# Clone the repository
git clone https://github.com/milady-ai/milady.git
cd milady

# Install dependencies
bun install

# Build the project (TypeScript via tsdown + UI build)
bun run build
```

Después de compilar, verifica que el CLI funciona:

```bash
bun run milady --help
```

La configuración se almacena en `~/.milady/milady.json` y el espacio de trabajo está en `~/.milady/workspace/`.

---

<div id="development-workflow">
## Flujo de trabajo de desarrollo
</div>

<div id="running-in-development">
### Ejecutar en desarrollo
</div>

```bash
# Start dev server with auto-reload
bun run dev

# Run UI development only
bun run dev:ui

# Desktop app (Electrobun) development
bun run dev:desktop

# Run the CLI directly
bun run milady start
```

<div id="testing">
### Pruebas
</div>

El proyecto usa **Vitest 4.x** con cobertura V8. Los umbrales de cobertura están configurados en `scripts/coverage-policy.mjs` al **25%** para líneas, funciones y declaraciones, y **15%** para ramas.

```bash
# Run all tests (parallel runner)
bun run test

# Watch mode
bun run test:watch

# Run with coverage report
bun run test:coverage

# Run database safety/migration compatibility checks
bun run db:check

# End-to-end tests
bun run test:e2e

# Live API tests (requires API keys)
MILADY_LIVE_TEST=1 bun run test:live

# Docker-based integration tests
bun run test:docker:all
```

**Convenciones de archivos de prueba:**

| Patrón | Ubicación | Propósito |
|--------|-----------|-----------|
| `*.test.ts` | Colocado junto al código fuente | Pruebas unitarias |
| `*.e2e.test.ts` | Directorio `test/` | Pruebas end-to-end |
| `*.live.test.ts` | Directorio `test/` | Pruebas de API en vivo (requieren claves reales) |

<div id="linting-and-formatting">
### Linting y formateo
</div>

El proyecto usa **Biome 2.x** tanto para linting como para formateo. No hay ESLint ni Prettier -- Biome maneja todo.

```bash
# Run typecheck + lint (the main pre-push check)
bun run check

# Auto-fix formatting issues
bun run format:fix

# Auto-fix lint issues
bun run lint:fix
```

Reglas clave de Biome configuradas en `biome.json`:

- `noExplicitAny`: **error** -- evitar tipos `any`
- `noNonNullAssertion`: warn
- `noImplicitAnyLet`: warn
- Formateador: indentación de 2 espacios, espacios (no tabs)
- Organización de imports habilitada

<div id="build-commands">
### Comandos de compilación
</div>

```bash
# Full build (TypeScript + UI)
bun run build

# Build using Node.js (instead of Bun runtime)
bun run build

# Desktop app (Electrobun)
bun run build:desktop

# Mobile builds
bun run build:android
bun run build:ios
```

---

<div id="pull-request-process">
## Proceso de pull request
</div>

<div id="branch-strategy">
### Estrategia de ramas
</div>

| Rama | Propósito |
|------|-----------|
| `main` | Releases estables (publicados en npm) |
| `develop` | Rama de integración (destino por defecto de PR) |
| `feature/*` | Nuevas funcionalidades |
| `fix/*` | Correcciones de errores |

Siempre crea ramas desde `develop` y dirige los PRs de vuelta a `develop`.

<div id="step-by-step">
### Paso a paso
</div>

1. **Crea una rama desde develop**
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```

2. **Haz cambios** con commits concisos y orientados a la acción
   ```bash
   git commit -m "milady: add verbose flag to send action"
   ```

3. **Ejecuta verificaciones antes de push**
   ```bash
   bun run check
   bun run test
   bun run build
   ```

4. **Push y abre un PR**
   ```bash
   git push origin feature/my-feature
   ```
   Abre el PR contra `develop` en GitHub.

<div id="commit-conventions">
### Convenciones de commit
</div>

El proyecto usa mensajes de commit concisos y orientados a la acción. Los prefijos de commit convencionales son comunes:

```
feat: add voice message support to telegram connector
fix: prevent crash when config file is missing
test: add regression test for session timeout
refactor: extract session key logic to provider
chore: update @elizaos/core to latest
```

Otros estilos aceptados siguen el patrón `milady: description` visto en el historial del repositorio (por ejemplo, `milady: fix telegram reconnect on rate limit`).

<div id="the-agent-review-bot">
### El bot de revisión de agentes
</div>

Cada PR activa el flujo de trabajo **Agent Review** de GitHub Actions. Así es como funciona:

1. **Clasificación** -- El flujo de trabajo clasifica automáticamente tu PR como `bugfix`, `feature` o `aesthetic` basándose en el título y el cuerpo.

2. **Claude Code Review** -- Un agente de IA (Claude Opus) realiza una revisión de código completa. Evalúa:
   - **Alcance** -- ¿El cambio está dentro del alcance del proyecto?
   - **Calidad del código** -- Modo estricto de TypeScript, cumplimiento de Biome, tamaño de archivos
   - **Seguridad** -- Inyección de prompts, exposición de credenciales, riesgos de cadena de suministro
   - **Pruebas** -- Las correcciones de bugs deben incluir pruebas de regresión; las funcionalidades deben incluir pruebas unitarias

3. **Decisión** -- El agente emite uno de tres veredictos:
   - **APPROVE** -- El PR pasa la revisión y se auto-fusiona (squash merge) en `develop`
   - **REQUEST CHANGES** -- Problemas encontrados; corrige y haz push de nuevo para volver a activar la revisión
   - **CLOSE** -- El PR está fuera del alcance y será cerrado automáticamente

4. **Puntuación de confianza** -- Los contribuidores construyen una puntuación de confianza con el tiempo. Mayor confianza significa revisiones expeditas; los nuevos contribuidores reciben un escrutinio más profundo.

**No hay ruta de escalamiento humano**. La decisión del agente es final. Si no estás de acuerdo, mejora el PR y vuelve a enviarlo.

**Qué se rechaza inmediatamente:**
- Rediseños estéticos/UI, cambios de temas, intercambios de iconos, cambios de fuentes
- PRs de "embellecimiento" que no mejoran la capacidad del agente
- Código sin pruebas para cambios testables
- Expansión del alcance disfrazada de mejoras

<div id="pr-checklist">
### Checklist del PR
</div>

Antes de enviar, verifica:

- [ ] `bun run build` se completa sin errores
- [ ] `bun run test` pasa
- [ ] `bun run check` pasa (typecheck + lint)
- [ ] Las correcciones de bugs incluyen una prueba de regresión
- [ ] Las nuevas funcionalidades incluyen pruebas unitarias
- [ ] Sin secretos, credenciales reales o valores de configuración en vivo en el código
- [ ] Los mensajes de commit son concisos y descriptivos
- [ ] La descripción del PR resume el cambio y nota las pruebas realizadas

---

<div id="code-style">
## Estilo de código
</div>

<div id="typescript">
### TypeScript
</div>

- **Modo estricto** -- Usa siempre TypeScript estricto
- **Sin `any`** -- Biome impone `noExplicitAny` como error. Usa tipos apropiados o `unknown`.
- **ESM** -- Usa sintaxis de módulos ES (`import`/`export`)
- **Async/await** -- Preferido sobre cadenas de promesas sin procesar

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

- **Milady** -- Nombre del producto, encabezados, prosa de documentación
- **milady** -- Nombre del binario CLI, rutas de paquetes, claves de configuración

<div id="file-size">
### Tamaño de archivo
</div>

Mantén los archivos por debajo de **~500 líneas**. Divide cuando mejore la claridad, testabilidad o reutilización.

<div id="comments">
### Comentarios
</div>

```typescript
// Explain WHY, not WHAT
// Rate limit to avoid API throttling during batch operations
const BATCH_DELAY_MS = 100;
```

<div id="error-handling">
### Manejo de errores
</div>

```typescript
// Specific error messages with context
throw new Error("Failed to load plugin: " + err.message);

// Graceful degradation over silent swallowing
try {
  await riskyOperation();
} catch (err) {
  runtime.logger?.warn(err, "Operation failed, using fallback");
  return fallbackValue;
}
```

<div id="editor-setup">
### Configuración del editor
</div>

Configuración recomendada de VS Code:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome"
}
```

Instala la [extensión Biome para VS Code](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) para formateo y feedback de lint en el editor.

---

<div id="project-structure">
## Estructura del proyecto
</div>

```
milady/
├── apps/
│   ├── app/                 # Desktop/mobile app (Capacitor + React)
│   │   ├── electrobun/      # Electrobun desktop wrapper
│   │   └── src/             # React UI components
├── deploy/                  # Docker deployment configs
├── docs/                    # Documentation site
├── packages/                # Workspace packages
├── plugins/                 # Workspace plugin packages
├── scripts/                 # Build, dev, and release tooling
├── skills/                  # Skill catalog cache
├── src/                     # Core source code
│   ├── actions/             # Agent actions
│   ├── api/                 # HTTP API routes
│   ├── cli/                 # CLI command definitions
│   ├── config/              # Configuration handling
│   ├── hooks/               # Runtime hooks
│   ├── plugins/             # Built-in plugins
│   ├── providers/           # Context providers
│   ├── runtime/             # elizaOS runtime wrapper
│   ├── security/            # Security utilities
│   ├── services/            # Background services
│   ├── triggers/            # Trigger system
│   ├── tui/                 # Terminal UI (disabled)
│   └── utils/               # Helper utilities
├── test/                    # Test setup, helpers, e2e scripts
├── AGENTS.md                # Repository guidelines for agents
├── CONTRIBUTING.md          # Contribution philosophy
├── package.json             # Root package config
├── plugins.json             # Plugin registry manifest
├── biome.json               # Biome linter/formatter config
├── tsconfig.json            # TypeScript config
├── tsdown.config.ts         # Build config (tsdown bundler)
├── vitest.config.ts         # Vitest test config
└── milady.mjs               # npm bin entry point
```

<div id="key-entry-points">
### Puntos de entrada clave
</div>

| Archivo | Propósito |
|---------|-----------|
| `src/entry.ts` | Punto de entrada CLI |
| `src/index.ts` | Exportaciones de librería |
| `src/runtime/eliza.ts` | Inicialización del runtime elizaOS |
| `src/runtime/milady-plugin.ts` | Plugin principal de Milady |
| `milady.mjs` | Entrada bin de npm (`"bin"` en package.json) |

---

<div id="reporting-issues">
## Reportar problemas
</div>

Al crear un reporte de error:

1. **Verifica los issues existentes** para evitar duplicados
2. **Incluye pasos de reproducción** -- qué hiciste, qué pasó, qué esperabas
3. **Comparte tu entorno** -- SO, versión de Node, versión de Milady (`milady --version`)
4. **Adjunta logs** -- salida de errores relevante

Un agente de IA triaje todos los issues entrantes. Los bugs válidos son etiquetados y priorizados. Los issues fuera del alcance (solicitudes estéticas, expansión de funcionalidades) serán cerrados con una explicación.

---

<div id="further-reading">
## Lectura adicional
</div>

- [CONTRIBUTING.md](https://github.com/milady-ai/milady/blob/develop/CONTRIBUTING.md) -- Filosofía completa de contribución
- [AGENTS.md](https://github.com/milady-ai/milady/blob/develop/AGENTS.md) -- Directrices del repositorio para agentes de codificación
- [Guía de desarrollo de plugins](/es/plugins/development) -- Crear plugins
- [Documentación de skills](/es/plugins/skills) -- Crear skills
- [Desarrollo local de plugins](/es/plugins/local-plugins) -- Desarrollar plugins localmente
