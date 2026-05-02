<div id="electrobun-desktop-app-startup-and-exception-handling">
# Aplicación de escritorio Electrobun: inicio y manejo de excepciones
</div>

Este documento explica cómo se inicia el agente embebido en la aplicación de escritorio empaquetada y **por qué** las protecciones de manejo de excepciones en `eliza/packages/app-core/platforms/electrobun/src/native/agent.ts` no deben eliminarse.

<div id="startup-sequence">
## Secuencia de inicio
</div>

1. **Proceso principal de Electrobun** se inicia, crea la ventana y resuelve la URL del renderizador (servidor de desarrollo Vite vía `ELIZA_RENDERER_URL` o el servidor de assets estáticos integrado para `apps/app/dist` empaquetado).
2. **`AgentManager.start()`** (en `native/agent.ts`) genera un **proceso hijo de Bun**: `bun run <eliza-dist>/entry.js start` (o la ruta equivalente para tu layout de bundle). El hijo **no** es un import dinámico en proceso de `server.js` / `eliza.js`.
3. **Proceso hijo** arranca el punto de entrada CLI de Eliza, inicia el servidor API y ejecuta el runtime de elizaOS en modo headless dentro de ese proceso.
4. **Proceso principal** sondea la salud en `http://127.0.0.1:{port}/api/health` hasta que el hijo reporta listo (o se agota el tiempo / hay errores).
5. **Proceso principal** envía `apiBaseUpdate` (y RPC relacionado) al renderizador para que `window.__ELIZA_API_BASE__` coincida con la API en vivo.

Si el hijo no logra iniciar o nunca se vuelve saludable:

- La **ventana de Electrobun permanece abierta** para que el usuario no se quede con un shell vacío.
- El **estado** se establece en `state: "error"` con un mensaje de error para que la UI pueda mostrar **Agent unavailable: …** en lugar de un genérico **Failed to fetch**.

Para la **orquestación de desarrollo** (Vite + API + Electrobun en procesos separados), consulta [Desarrollo local de escritorio](./apps/desktop-local-development.md).

<div id="why-the-guards-exist">
## Por qué existen las protecciones
</div>

**Objetivo:** Cuando el runtime falla al cargar (por ejemplo, falta un binario nativo), el usuario debe ver un error claro en la UI, no una ventana muerta. Eso requiere (1) que el proceso principal y el renderizador permanezcan activos, y (2) actualizaciones de estado / RPC para que la UI pueda mostrar **Agent unavailable: …**.

Sin manejo explícito:

1. Si el **proceso hijo se cae** o la salud nunca tiene éxito, el proceso principal debe exponer eso como estado **error** al renderizador.
2. Si el **`start()` externo** destruyera la ventana o asumiera que la API vivía en proceso, el renderizador podría perder la **base de la API** y mostrar **Failed to fetch** sin explicación.

Por eso mantenemos:

- **Aislamiento de proceso hijo** — Las fallas de API + runtime están contenidas en el hijo; el proceso principal observa códigos de salida / salud.
- **try/catch y `.catch()` donde aún aplica** — Cualquier ruta asíncrona restante que pueda rechazar debe establecer el estado **error** en vez de dejar la UI sin inicializar.
- **Rutas externas que NO deben matar el shell** cuando el objetivo es mostrar un error en la app — alineado con los comentarios en `native/agent.ts` y este documento.

<div id="do-not-remove-as-excess">
## No eliminar como "exceso"
</div>

Las revisiones de código o las pasadas automatizadas de "deslop" a veces eliminan try/catch o `.catch()` como "redundantes" o "manejo de excepciones excesivo." En este módulo, esas protecciones son **intencionales**: mantienen la ventana de la aplicación utilizable cuando el runtime falla al cargar. Eliminarlas traería de vuelta el comportamiento roto (ventana muerta, **Failed to fetch**, sin mensaje de error).

El archivo y los sitios clave en `agent.ts` incluyen comentarios **WHY** que referencian este documento. Al editar ese archivo, preserva las protecciones y la justificación.

<div id="logs">
## Logs
</div>

La aplicación empaquetada escribe un log de inicio en:

- **macOS:** `~/Library/Application Support/Eliza/eliza-startup.log`
- **Windows:** `%APPDATA%\Eliza\eliza-startup.log`
- **Linux:** `~/.config/Eliza/eliza-startup.log`

Úsalo para depurar fallos de carga (módulos faltantes, ruta de binario nativo, etc.).

<div id="see-also">
## Ver también
</div>

- [Resolución de plugins y NODE_PATH](./plugin-resolution-and-node-path.md) — por qué los imports dinámicos de plugins necesitan `NODE_PATH` y dónde se establece.
- [Compilación y lanzamiento](./build-and-release.md) — Pipeline de CI, builds Rosetta, copiado de plugins/deps.
