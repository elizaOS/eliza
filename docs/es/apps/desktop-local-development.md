---
title: Desarrollo local de escritorio
sidebarTitle: Desarrollo local
description: Por qué y cómo el orquestador de desarrollo de escritorio de Eliza (scripts/dev-platform.mjs) ejecuta Vite, la API y Electrobun juntos — variables de entorno, señales y comportamiento de cierre.
---

La **pila de desarrollo de escritorio** no es un solo binario. `bun run dev:desktop` y `bun run dev:desktop:watch` ejecutan `scripts/dev-platform.mjs`, que **orquesta** procesos separados: compilación única opcional de `vite build`, `tsdown` opcional en la raíz del repositorio, luego **Vite** de larga duración (cuando `ELIZA_DESKTOP_VITE_WATCH=1`), **`bun --watch` API**, y **Electrobun**.

**¿Por qué orquestar?** Electrobun necesita (a) una URL de renderizado, (b) generalmente una API del dashboard ejecutándose, y (c) en desarrollo, un paquete `dist/` en la raíz para el runtime embebido de Eliza. Hacerlo manualmente es propenso a errores; un solo script mantiene los puertos, las variables de entorno y el cierre consistentes.

<div id="commands">
## Comandos
</div>

**Flags de CLI** (preferidos para uso ad-hoc; `bun run dev:desktop -- --help` los lista): `--no-api`, `--force-renderer`, `--rollup-watch`, `--vite-force`.

| Comando | Qué inicia | Uso típico |
|---------|------------|------------|
| `bun run dev:desktop` | API (a menos que `--no-api`) + Electrobun; **omite** `vite build` cuando `apps/app/dist` es más reciente que las fuentes | Iteración rápida contra assets de renderizado **compilados** |
| `bun run dev:desktop:watch` | Mismo orquestador con **`ELIZA_DESKTOP_VITE_WATCH=1`** — **Servidor de desarrollo Vite** + HMR | Flujo de trabajo de UI de escritorio |
| `bun run dev` / `bun run dev:web:ui` | Solo la pila del dashboard del navegador (API + Vite) | Iteración del dashboard compatible con headless |

**Tablas de inicio:** el orquestador, Vite, API y Electrobun cada uno imprime una **tabla de configuración en texto plano** (columnas *Setting / Effective / Source / Change*) para que puedas ver los valores por defecto vs entorno y cómo cambiar una opción. Ejecútalo sin `--help` para verlas en la terminal.

<div id="startup-tables-and-terminal-banners">
### Tablas de inicio y banners de terminal
</div>

En un **TTY**, las tablas pueden usar un **marco de caja Unicode** y un gran título estilo **figlet** para el nombre del subsistema (orquestador, Vite, API, Electrobun), con **color ANSI** (título magenta, marco cyan) a menos que **`NO_COLOR`** esté establecido (**`FORCE_COLOR`** puede activarlo para salida redirigida).

**Por qué:** El desarrollo de escritorio ejecuta **cuatro procesos** con entorno superpuesto (puertos, URLs, flags de características). El objetivo es el **escaneo visual rápido** de valores *efectivos* para humanos y agentes de IDE — la misma lógica que la pre-asignación de puertos y los logs prefijados. Esto **no** es la UI del companion o del dashboard; no se entrega a los usuarios finales como interfaz del producto.

**Docs:** [Diagnósticos de desarrollador y espacio de trabajo](../guides/developer-diagnostics-and-workspace.md).

**¿Por qué comandos separados?** Una compilación completa de Vite de **producción** sigue siendo útil cuando quieres paridad con los assets publicados o cuando no estás tocando la UI del shell de escritorio. `bun run dev:desktop:watch` apunta Electrobun al servidor de desarrollo de Vite para HMR, mientras que `bun run dev` permanece en la pila del dashboard del navegador.

<div id="legacy-rollup-vite-build---watch">
### Legacy: Rollup `vite build --watch`
</div>

Si necesitas explícitamente salida de archivos en cada guardado (por ejemplo, depurando el comportamiento de Rollup):

```bash
ELIZA_DESKTOP_VITE_WATCH=1 bun scripts/dev-platform.mjs -- --rollup-watch
# or env-only:
ELIZA_DESKTOP_VITE_WATCH=1 ELIZA_DESKTOP_VITE_BUILD_WATCH=1 bun scripts/dev-platform.mjs
```

**Por qué esto es opt-in:** `vite build --watch` aún ejecuta emisiones de producción de Rollup; "3 modules transformed" puede significar **segundos** reescribiendo chunks de múltiples MB. La ruta de watch por defecto usa el **servidor de desarrollo de Vite** en su lugar.

<div id="environment-variables">
## Variables de entorno
</div>

| Variable | Propósito |
|----------|-----------|
| `ELIZA_DESKTOP_VITE_WATCH=1` | Habilita el flujo de trabajo de watch (servidor de desarrollo por defecto; ver abajo) |
| `ELIZA_DESKTOP_VITE_BUILD_WATCH=1` | Con `VITE_WATCH`, usa `vite build --watch` en vez de `vite dev` |
| `ELIZA_PORT` | Puerto de Vite / UI esperado (por defecto **2138**) |
| `ELIZA_API_PORT` | Puerto de la API (por defecto **31337**); reenviado al proxy env de Vite y Electrobun |
| `ELIZA_RENDERER_URL` | Establecido **por el orquestador** cuando usa Vite dev — el `resolveRendererUrl()` de Electrobun prefiere esto sobre el servidor estático integrado (**por qué:** HMR solo funciona contra el servidor de desarrollo) |
| `ELIZA_DESKTOP_RENDERER_BUILD=always` | Fuerza `vite build` incluso cuando `dist/` parece reciente |
| `--force-renderer` | Lo mismo que siempre recompilar el renderizador |
| `--vite-force` | Pasa `vite --force` cuando se inicia el servidor de desarrollo Vite (limpia la caché de optimización de deps) |
| `--rollup-watch` | Con `ELIZA_DESKTOP_VITE_WATCH=1`, usa `vite build --watch` en vez de `vite dev` |
| `--no-api` | Solo Electrobun; sin hijo `dev-server.ts` |
| `ELIZA_DESKTOP_SCREENSHOT_SERVER` | **Activo por defecto** para `dev:desktop` / `bun run dev`: Electrobun escucha en `127.0.0.1:ELIZA_SCREENSHOT_SERVER_PORT` (por defecto **31339**); la API de Eliza hace proxy de **`GET /api/dev/cursor-screenshot`** (loopback) como un **PNG de pantalla completa** para agentes/herramientas (macOS necesita permiso de Screen Recording). Establece **`0`**, **`false`**, **`no`**, u **`off`** para desactivar. |
| `ELIZA_DESKTOP_DEV_LOG` | **Activo por defecto:** los logs de hijos (vite / api / electrobun) se reflejan en **`.eliza/desktop-dev-console.log`** en la raíz del repositorio. **`GET /api/dev/console-log`** en la API (loopback) devuelve un tail (`?maxLines=`, `?maxBytes=`). Establece **`0`** / **`false`** / **`no`** / **`off`** para desactivar. |

<div id="when-default-ports-are-busy">
### Cuando los puertos por defecto están ocupados
</div>

`scripts/dev-platform.mjs` ejecuta **`dev:desktop`** y **`bun run dev`**. Antes de iniciar los hijos de larga duración, **sondea TCP en loopback** comenzando en:

| Env | Rol | Por defecto |
|-----|-----|-------------|
| **`ELIZA_API_PORT`** | API de Eliza (`dev-server.ts`) | **31337** |
| **`ELIZA_PORT`** | Servidor de desarrollo Vite (solo modo watch) | **2138** |

Si el puerto preferido ya está en uso, el orquestador prueba **preferred + 1**, luego +2, ... (con límite), y pasa los valores **resueltos** a **cada** hijo (`ELIZA_DESKTOP_API_BASE`, **`ELIZA_RENDERER_URL`**, **`ELIZA_PORT`** de Vite, etc.).

**Por qué pre-asignar en el padre (no solo dentro del proceso de la API):** Vite lee `vite.config.ts` una vez al inicio; el **`target`** del proxy debe coincidir con el puerto de la API **antes** de la primera solicitud. Si solo la API cambiara puertos después de bind, la UI seguiría haciendo proxy al viejo valor por defecto hasta que alguien reiniciara Vite. Resolver puertos **una vez** en `dev-platform.mjs` mantiene **logs del orquestador, env, proxy y Electrobun** en los mismos números.

**Escritorio empaquetado (agente `local` embebido):** el proceso principal de Electrobun llama a **`findFirstAvailableLoopbackPort`** (`apps/app/electrobun/src/native/loopback-port.ts`) desde el **`ELIZA_PORT`** preferido (por defecto **2138**), lo pasa al hijo **`entry.js start`**, y después de un inicio saludable actualiza **`process.env.ELIZA_PORT` / `ELIZA_API_PORT`** en el shell. **Por qué dejamos de usar `lsof` + SIGKILL por defecto:** una segunda instancia de Eliza (o cualquier app) en el mismo puerto por defecto es válida cuando los directorios de estado difieren; matar PIDs desde el shell es sorprendente y puede terminar trabajo no relacionado. **Reclaim opt-in:** **`ELIZA_AGENT_RECLAIM_STALE_PORT=1`** ejecuta el antiguo comportamiento de **"liberar este puerto primero"** para desarrolladores que quieren toma de control de instancia única.

**Ventanas separadas:** cuando el puerto de la API embebida se finaliza o cambia, **`injectApiBase`** se ejecuta para la ventana principal y **todas** las ventanas de `SurfaceWindowManager` (**por qué:** chat/settings/etc. no deben seguir sondeando un `http://127.0.0.1:…` obsoleto).

**Relacionado:** [Aplicación de escritorio — Configuración de puertos](./desktop#port-configuration); **`GET /api/dev/stack`** sobrescribe **`api.listenPort`** desde el **socket aceptado** cuando es posible (**por qué:** la verdad supera al env si algo más redirige el servidor).

<div id="macos-frameless-window-chrome-native-dylib">
## macOS: chrome de ventana sin marco (dylib nativo)
</div>

En **macOS**, Electrobun solo copia **`libMacWindowEffects.dylib`** en el bundle de desarrollo cuando ese archivo existe (ver `apps/app/electrobun/electrobun.config.ts`). Sin él, el **layout de semáforos, regiones de arrastre y redimensionamiento de borde interno** pueden faltar o estar incorrectos — fácil de confundir con un bug genérico de Electrobun.

Después de clonar el repositorio, o cuando cambies `native/macos/window-effects.mm`, compila el dylib desde el paquete Electrobun:

```bash
cd apps/app/electrobun && bun run build:native-effects
```

Más detalle: [Paquete shell de Electrobun](https://github.com/eliza-ai/eliza/tree/main/apps/app/electrobun) (README: *macOS window chrome*), y [Chrome de ventana macOS de Electrobun](../guides/electrobun-mac-window-chrome.md).

<div id="macos-local-network-permission-gateway-discovery">
## macOS: permiso de Red Local (descubrimiento de gateway)
</div>

El shell de escritorio usa **Bonjour/mDNS** para descubrir gateways de Eliza en tu LAN. macOS puede mostrar un diálogo de privacidad de **Red Local** — elige **Permitir** si dependes del descubrimiento local.

La configuración de tipos de **Electrobun** fijada por Eliza (a partir de la versión en este repositorio) **no** expone un merge de `Info.plist` para **`NSLocalNetworkUsageDescription`**, por lo que el sistema operativo puede mostrar un mensaje genérico. Si upstream añade ese hook más adelante, podremos establecer un texto más claro; el comportamiento no depende de ello.

<div id="why-vite-build-is-sometimes-skipped">
## Por qué `vite build` a veces se omite
</div>

Antes de iniciar los servicios, el script verifica `viteRendererBuildNeeded()` (`scripts/lib/vite-renderer-dist-stale.mjs`): compara el mtime de `apps/app/dist/index.html` contra `apps/app/src`, `vite.config.ts`, paquetes compartidos (`packages/ui`, `packages/app-core`), etc.

**¿Por qué mtime, no un grafo completo de dependencias?** Es una **heurística local barata** para que los reinicios no paguen 10–30s por una compilación de producción redundante cuando las fuentes no cambiaron. Sobreescríbelo cuando necesites un bundle limpio.

<div id="signals-ctrl-c-and-detached-children-unix">
## Señales, Ctrl-C y procesos hijos `detached` (Unix)
</div>

En **macOS/Linux**, los procesos hijos de larga duración se inician con `detached: true` para que vivan en una **sesión separada** del orquestador.

**Por qué:** Un **Ctrl-C** en TTY se entrega al **grupo de procesos en primer plano**. Sin `detached`, Electrobun, Vite y la API reciben **SIGINT** juntos. Electrobun maneja la primera interrupción ("press Ctrl+C again…") mientras **Vite y la API siguen ejecutándose**; el padre permanece vivo porque los **pipes de stdio** siguen abiertos — se siente como si el primer Ctrl-C "no hizo nada."

Con `detached`, **solo el orquestador** recibe el **SIGINT** del TTY; ejecuta una única ruta de cierre: **SIGTERM** a cada subárbol conocido, breve gracia, luego **SIGKILL**, después `process.exit`.

**Segundo Ctrl-C** mientras se está cerrando **fuerza la salida** inmediatamente (`exit 1`) para que nunca quedes atrapado detrás de un temporizador de gracia.

**Windows:** `detached` **no** se usa de la misma manera (stdio + modelo de procesos difieren); la limpieza de puertos usa `netstat`/`taskkill` en vez de solo `lsof`.

<div id="quitting-from-the-app-electrobun-exits">
## Salir desde la aplicación (Electrobun sale)
</div>

Si haces **Quit** desde el menú nativo, Electrobun sale con código 0 mientras **Vite y la API pueden seguir ejecutándose**. El orquestador vigila el hijo **electrobun**: al salir, **detiene los servicios restantes** y sale.

**Por qué:** De lo contrario, la sesión de terminal se cuelga después de "App quitting…" porque el proceso padre sigue sosteniendo pipes hacia Vite/API — el mismo problema subyacente que un cierre incompleto de Ctrl-C.

<div id="port-cleanup-before-vite-killuilistenport">
## Limpieza de puertos antes de Vite (`killUiListenPort`)
</div>

Antes de vincular el puerto de UI, el script intenta matar lo que esté escuchando (**por qué:** un Vite obsoleto o una ejecución fallida deja `EADDRINUSE`). Implementación: `scripts/lib/kill-ui-listen-port.mjs` (Unix: `lsof`; Windows: `netstat` + `taskkill`).

<div id="process-trees-and-kill-process-tree">
## Árboles de procesos y `kill-process-tree`
</div>

El cierre usa `signalSpawnedProcessTree` — **solo** el árbol de PIDs enraizado en cada hijo **generado** (**por qué:** evitar nukes estilo `pkill bun` que matarían espacios de trabajo Bun no relacionados en la máquina).

<div id="seeing-many-bun-processes">
## Ver muchos procesos `bun`
</div>

**Esperado.** Típicamente tienes: el orquestador, `bun run vite`, `bun --watch` API, `bun run dev` bajo Electrobun (compilación de preload + `bunx electrobun dev`), más internos de Bun/Vite/Electrobun. Preocúpate si los conteos **crecen sin límite** o los procesos **sobreviven** después de que la sesión de desarrollo termine completamente.

<div id="ide-and-agent-observability-cursor-scripts">
## Observabilidad para IDE y agentes (Cursor, scripts)
</div>

Los editores y agentes de codificación **no** ven la ventana nativa de Electrobun, no escuchan audio, ni auto-descubren localhost. Eliza añade **hooks explícitos y legibles por máquina** para que las herramientas puedan razonar sobre "qué está ejecutándose" y aproximar "qué ve el usuario."

**Por qué existe esto**

1. **Verdad multi-proceso** — La salud no es un solo PID. Vite, la API y Electrobun pueden discrepar en puertos; los logs se intercalan. Un solo endpoint JSON y un archivo de log evitan "buscar en cinco terminales."
2. **Seguridad vs conveniencia** — Los endpoints de screenshot y tail de logs son **solo loopback**; la ruta del screenshot usa un **token de sesión** entre Electrobun y el proxy de la API; la API de logs solo hace tail de un archivo llamado **`desktop-dev-console.log`**. **Por qué:** local-first no significa "cualquier proceso en la LAN puede obtener tu pantalla."
3. **Defaults opt-out** — Screenshot y logging agregado están **activos** para `dev:desktop` / `bun run dev` porque agentes y humanos depurando juntos se benefician; ambos se desactivan con **`ELIZA_DESKTOP_SCREENSHOT_SERVER=0`** y **`ELIZA_DESKTOP_DEV_LOG=0`** para que puedas reducir la superficie de ataque o el I/O de disco.
4. **Cursor no hace auto-poll** — El descubrimiento es **documentación + `.cursor/rules`** (ver repositorio) más tú pidiendo al agente que ejecute `curl` o lea un archivo. **Por qué:** el producto no escanea silenciosamente tu máquina; los hooks están ahí cuando se indican.

<div id="get-apidevstack-eliza-api">
### `GET /api/dev/stack` (API de Eliza)
</div>

Devuelve JSON estable (`schema: eliza.dev.stack/v1`): **puerto de escucha** de la API (desde el **socket** cuando es posible), URLs/puertos del **escritorio** desde env (`ELIZA_RENDERER_URL`, `ELIZA_PORT`, …), disponibilidad y rutas de **`cursorScreenshot`** / **`desktopDevLog`**, y **hints** cortos (por ejemplo, el puerto RPC interno de Electrobun en los logs del launcher).

**Por qué en la API:** los agentes a menudo ya sondean `/api/health`; un GET extra reutiliza el mismo host y evita parsear el puerto efímero de Electrobun.

<div id="bun-run-desktopstack-status----json">
### `bun run desktop:stack-status -- --json`
</div>

Script: `scripts/desktop-stack-status.mjs` (con `scripts/lib/desktop-stack-status.mjs`). Sondea puertos de UI/API, obtiene `/api/dev/stack`, `/api/health`, y `/api/status`.

**Por qué un CLI:** los agentes y CI pueden ejecutarlo sin cargar el dashboard; el código de salida JSON refleja la salud de la API para automatización simple.

<div id="full-screen-png--get-apidevcursor-screenshot">
### PNG de pantalla completa — `GET /api/dev/cursor-screenshot`
</div>

**Solo loopback.** Hace proxy del servidor de desarrollo de Electrobun (por defecto **`127.0.0.1:31339`**) que usa la misma **captura a nivel de OS** que `ScreenCaptureManager.takeScreenshot()` (por ejemplo, macOS `screencapture`). **No** son solo los píxeles del webview.

**Por qué proxy a través de la API:** una URL en el puerto familiar de la API; el token permanece en env entre los hijos generados por el orquestador. **Por qué pantalla completa primero:** la captura por window-ID es específica de plataforma; esta ruta reutiliza código existente y probado.

<div id="aggregated-console--file--get-apidevconsolelog">
### Consola agregada — archivo + `GET /api/dev/console-log`
</div>

Líneas prefijadas de **vite / api / electrobun** se reflejan en **`.eliza/desktop-dev-console.log`** (banner de sesión en cada inicio del orquestador). **`GET /api/dev/console-log`** (loopback) devuelve un **tail de texto**; query **`maxLines`** (por defecto 400, límite 5000) y **`maxBytes`** (por defecto 256000).

**Por qué un archivo:** los agentes pueden `read_file` la ruta desde `desktopDevLog.filePath` sin HTTP. **Por qué tail HTTP:** evita leer logs de múltiples megabytes en contexto; los límites previenen OOM. **Por qué lista de nombres permitidos:** `ELIZA_DESKTOP_DEV_LOG_PATH` de otro modo podría apuntar a archivos arbitrarios.

<div id="ui-e2e-playwright">
## E2E de UI (Playwright)
</div>

Las pruebas de humo del navegador apuntan a la **misma URL de renderizado** que Electrobun carga en modo watch (`http://localhost:<ELIZA_PORT>`, por defecto **2138**). **No** controlan el webview nativo de Electrobun; el tray, menús nativos y comportamientos solo de empaquetado permanecen cubiertos por **`bun run test:desktop:packaged`** (donde aplique) y la [checklist de regresión de lanzamiento](./release-regression-checklist.md).

**Por qué Playwright:** la app ya incluye Playwright para verificaciones de renderizado y empaquetado, así que los flujos de humo del navegador ahora usan la misma pila soportada en lugar de un toolchain separado de TestCafe. Esto elimina la dependencia vulnerable `replicator` por completo y mantiene la superficie E2E de UI en un solo runner.

**Dependencia:** Playwright vive en **`@elizaai/app`** y las specs de humo viven en `apps/app/test/ui-smoke/`. Un `bun install` normal en la raíz aún eleva los paquetes del workspace; estas verificaciones del navegador son opt-in vía `test:ui:playwright*`.

**Runtime del navegador:** la suite usa Playwright Chromium. Instala el navegador una vez con `cd apps/app && bunx playwright install chromium` si no está presente en la máquina.

| Comando | Propósito |
|---------|-----------|
| `bun run test:ui:playwright` | Ejecuta [`apps/app/test/ui-smoke/ui-smoke.spec.ts`](../../apps/app/test/ui-smoke/ui-smoke.spec.ts); auto-inicia el renderizador Vite en **:2138** cuando es necesario. |
| `bun run test:ui:playwright:settings-chat` | Ejecuta [`apps/app/test/ui-smoke/settings-chat-companion.spec.ts`](../../apps/app/test/ui-smoke/settings-chat-companion.spec.ts) para persistencia de configuración de medios del companion. |
| `bun run test:ui:playwright:packaged` | Ejecuta [`apps/app/test/ui-smoke/packaged-hash.spec.ts`](../../apps/app/test/ui-smoke/packaged-hash.spec.ts) contra `apps/app/dist/index.html`; omite si `dist` no existe. |

**Matriz completa de pruebas:** `bun run test` **no** ejecuta las pruebas de humo de Playwright UI por defecto. Establece **`ELIZA_TEST_UI_PLAYWRIGHT=1`** para añadir la suite de UI a `test/scripts/test-parallel.mjs` (serial, después de Vitest e2e). `ELIZA_TEST_UI_TESTCAFE=1` aún se acepta como alias legacy.

**Ruta A vs webview nativo (Fase B):** Estas specs aún apuntan a la URL del renderizador, no al webview embebido de Electrobun. Los comportamientos empaquetados/nativos permanecen cubiertos por **`bun run test:desktop:packaged`**, **`bun run test:desktop:playwright`**, y la [checklist de regresión de lanzamiento](./release-regression-checklist.md).

<div id="related-source">
## Fuentes relacionadas
</div>

| Pieza | Rol |
|-------|-----|
| `.cursor/rules/eliza-desktop-dev-observability.mdc` | Cursor: cuándo usar los hooks de stack / screenshot / consola (**por qué:** el producto no auto-escanea localhost) |
| `scripts/dev-platform.mjs` | Orquestador; establece env para stack / screenshot / ruta de log |
| `scripts/lib/vite-renderer-dist-stale.mjs` | Cuándo se necesita `vite build` |
| `scripts/lib/kill-ui-listen-port.mjs` | Liberar puerto de UI |
| `scripts/lib/kill-process-tree.mjs` | Kill de árbol con alcance |
| `scripts/lib/desktop-stack-status.mjs` | Sondeos de puerto + HTTP para `desktop:stack-status` |
| `scripts/desktop-stack-status.mjs` | Entrada CLI para agentes (`--json`) |
| `packages/app-core/src/api/dev-stack.ts` | Payload para `GET /api/dev/stack` |
| `packages/app-core/src/api/dev-console-log.ts` | Lectura segura de tail para `GET /api/dev/console-log` |
| `apps/app/electrobun/src/index.ts` | `resolveRendererUrl()`; inicia el servidor de desarrollo de screenshot cuando está habilitado |
| `apps/app/electrobun/src/screenshot-dev-server.ts` | Servidor PNG en loopback (proxy como `/api/dev/cursor-screenshot`) |
| `apps/app/playwright.ui-smoke.config.ts` | Config de Playwright para specs de humo del renderizador |
| `apps/app/playwright.ui-packaged.config.ts` | Config de Playwright para humo de `file://` empaquetado |
| `apps/app/test/ui-smoke/ui-smoke.spec.ts` | Recorrido principal de UI + paridad de `TAB_PATHS` (por ejemplo, `/apps` deshabilitado) |
| `apps/app/test/ui-smoke/settings-chat-companion.spec.ts` | Persistencia de configuración de medios del companion |
| `apps/app/test/ui-smoke/packaged-hash.spec.ts` | Paridad de `file://` + hash routing |

<div id="see-also">
## Ver también
</div>

- [Aplicación de escritorio (Electrobun)](/es/apps/desktop) — modos de runtime, IPC, descargas
- [Inicio y manejo de excepciones de Electrobun](../electrobun-startup.md) — por qué el try/catch del proceso principal permanece
