---
title: Diagnósticos para desarrolladores y herramientas de workspace
---

# Diagnósticos para desarrolladores y herramientas de workspace (POR QUÉs)

Esta guía es para **personas que compilan Eliza desde el código fuente** — editores, agentes y mantenedores. Explica **por qué** existen ciertos comportamientos recientes orientados al desarrollador para que puedas depurar más rápido sin confundir ruido opcional con errores del producto.

<div id="plugin-load-reasons-optional-plugins">
## Razones de carga de plugins (plugins opcionales)
</div>

**Problema:** Registros como `Cannot find module '@elizaos/plugin-solana'` o "browser server not found" parecían indicar que el runtime estaba roto, cuando a menudo el verdadero problema era que la **configuración o una variable de entorno** incluía un plugin en el conjunto de carga mientras el paquete o binario nativo nunca fue instalado.

**Por qué rastreamos la procedencia:** `collectPluginNames()` puede registrar la **primera** fuente que añadió cada paquete (por ejemplo `plugins.allow["@elizaos/plugin-solana"]`, `env: SOLANA_PRIVATE_KEY`, `features.browser`, `CORE_PLUGINS`). `resolvePlugins()` pasa ese mapa a través de la resolución; cuando un plugin **opcional** falla por una razón benigna (módulo npm faltante, stagehand faltante), el resumen del registro incluye **`(added by: …)`** para que sepas si debes editar `eliza.json`, desactivar una variable de entorno, instalar un paquete o añadir un checkout de plugin.

**Alcance:** Esto son **diagnósticos**, no ocultar fallos. Los errores serios de resolución siguen apareciendo normalmente.

**Código relacionado:** `eliza/packages/agent/src/runtime/plugin-collector.ts`, `eliza/packages/agent/src/runtime/plugin-resolver.ts`. Consulta también [Resolución de plugins y NODE_PATH](/es/plugin-resolution-and-node-path#optional-plugins-why-was-this-package-in-the-load-set).

<div id="browser--stagehand-server-path">
## Ruta del servidor browser / stagehand
</div>

**Problema:** `@elizaos/plugin-browser` espera un árbol binario **stagehand-server** bajo `dist/server/` dentro del paquete npm, pero el tarball publicado no lo incluye. Eliza enlaza o descubre un checkout bajo `plugins/plugin-browser/stagehand-server/`.

**Por qué se recorre hacia arriba:** El archivo del runtime vive a diferentes profundidades (`eliza/packages/agent/...` vs `eliza/packages/agent/...` cuando se usa un submódulo). Una profundidad fija `../` no alcanzaba la raíz del workspace. **`findPluginBrowserStagehandDir()`** recorre los directorios padres hasta encontrar `plugins/plugin-browser/stagehand-server` con `dist/index.js` o `src/index.ts`.

**Nota operativa:** Si no usas automatización de navegador, la ausencia de stagehand es **esperada**; los mensajes son intencionalmente concisos a nivel de depuración para no saturar el desarrollo diario.

**Relacionado:** `scripts/link-browser-server.mjs`, `eliza/packages/agent/src/runtime/eliza.ts` (`ensureBrowserServerLink`, `findPluginBrowserStagehandDir`).

<div id="life-ops-schema-migrations-pglite">
## Migraciones de esquema life-ops (PGlite)
</div>

**Problema:** En **PGlite** / Postgres, `SAVEPOINT` solo funciona dentro de una transacción; las llamadas ad hoc a `executeRawSql` usan autocommit por defecto. Las migraciones anidadas que usaban savepoints sin un `BEGIN`/`COMMIT` externo fallaban o se comportaban de forma inconsistente.

**Por qué transacciones explícitas:** `runMigrationWithSavepoint()` envuelve cada migración nombrada en `BEGIN` → `SAVEPOINT` → … → `RELEASE`/`ROLLBACK TO` → `COMMIT` (o `ROLLBACK` en caso de fallo externo). Esto coincide con la semántica de Postgres y mantiene válido el comportamiento de SQLite también.

**Índices vs `ALTER TABLE`:** Los índices en `life_task_definitions` y tablas relacionadas hacen referencia a **columnas de propiedad** (`domain`, `subject_type`, …). **Por qué los índices se ejecutan después de los ALTERs:** las bases de datos heredadas creadas antes de que existieran esas columnas fallarían en `CREATE INDEX` si los índices se ejecutaran en el mismo lote que el `CREATE TABLE` inicial sin las columnas presentes. Las sentencias de índices principales se aplican **después** de los pasos de `ALTER TABLE` / relleno de propiedad.

**Tests:** `packages/agent/test/lifeops-pglite-schema.test.ts` cubre las rutas de actualización heredadas.

<div id="workspace-dependency-scripts">
## Scripts de dependencias de workspace
</div>

**Problema:** Los monorepos que mezclan **`workspace:*`**, rangos semver publicados y checkouts locales `./eliza` / `plugins/*` se desalinean fácilmente. Las ediciones manuales de `package.json` son propensas a errores y difíciles de revisar.

**Por qué existen los scripts:**

| Script / comando npm | Función |
|----------------------|--------|
| `workspace:deps:sync` (`fix-workspace-deps.mjs`) | Normalizar las dependencias de workspace a una forma consistente después de cambios upstream o locales. |
| `workspace:deps:check` / `--check` | Verificar sin escribir — CI o pre-commit. |
| `workspace:deps:restore` | Restaurar referencias `workspace:*` donde sea apropiado. |
| `workspace:replace-versions` / `workspace:restore-refs` | Operaciones dirigidas de cadenas de versión alineadas con los patrones de herramientas upstream de eliza. |
| `workspace:prepare` | Paso de preparación secuencial para checkouts nuevos o después de cambios de rama. |

**Descubrimiento:** `scripts/lib/workspace-discovery.mjs` centraliza cómo encontramos las raíces de workspace y paquetes de plugins para que los scripts no dupliquen lógica de rutas frágil.

<div id="terminal-dev-banners-orchestrator-vite-api-electrobun">
## Banners de terminal en desarrollo (orquestador, Vite, API, Electrobun)
</div>

**Qué:** En TTYs, el inicio puede mostrar una **tabla de configuración con marco Unicode** más un **encabezado grande estilo figlet** por subsistema (orquestador, Vite, API, Electrobun), con **ANSI cyan/magenta** cuando el color está permitido (`NO_COLOR` / `FORCE_COLOR` respetados).

**Por qué esto no es "UI de producto":** La salida es **stdout solo para desarrollo local** — misma categoría que las tablas de puertos y prefijos de registro. **Objetivo:** escaneo más rápido por humanos/agentes del **entorno efectivo** (puertos, flags de funcionalidad, fuentes) cuando arrancan cuatro procesos. No cambia el renderizado del panel de control, chat o companion.

**Ubicación:** `packages/shared` (helpers de tabla + color + figlet), `scripts/dev-platform.mjs`, `apps/app/vite.config.ts`, `packages/app-core/src/runtime/dev-server.ts`, helper de banner Electrobun bajo `apps/app/electrobun/src/`.

**Documentación relacionada:** [Desarrollo local de escritorio](/es/apps/desktop-local-development#startup-tables-and-terminal-banners).

<div id="gitignored-local-artifacts">
## Artefactos locales ignorados por git
</div>

**`cache/audio/`** — Las cachés locales de TTS o medios pueden crecer mucho; **no** son parte del árbol de código fuente.

**`scripts/bin/*` (excepto `.gitkeep`)** — Lugar opcional para colocar herramientas (p. ej. `yt-dlp`) para el `PATH` en scripts de desarrollo de Electrobun. **Por qué no se commitean binarios:** tamaño, variación de plataforma y el ciclo de vida de licencias/actualizaciones pertenecen a la máquina del desarrollador, no a git.

---

Consulta el [Registro de cambios](/es/changelog) para las fechas de lanzamiento y el [Roadmap](/es/ROADMAP) para los seguimientos.
