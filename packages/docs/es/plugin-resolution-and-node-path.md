<div id="plugin-resolution-why-node_path-is-needed">
# Resolución de plugins: por qué se necesita NODE_PATH
</div>

Este documento explica **por qué** los imports dinámicos de plugins fallan sin `NODE_PATH` y **cómo** lo solucionamos en CLI, dev server y Electrobun.

<div id="the-problem">
## El problema
</div>

El runtime (`src/runtime/eliza.ts`) carga plugins vía import dinámico:

```ts
import("@elizaos/plugin-sql")
```

Node resuelve esto recorriendo hacia arriba desde el **directorio del archivo que importa**. Cuando eliza se ejecuta desde diferentes ubicaciones, la resolución puede fallar:

| Punto de entrada | Ubicación del archivo importador | Recorre hacia arriba desde | ¿Alcanza el `node_modules` raíz? |
|---|---|---|---|
| `bun run dev` | `src/runtime/eliza.ts` | `src/runtime/` | Generalmente sí (2 niveles) |
| `eliza start` (CLI) | `dist/runtime/eliza.js` | `dist/runtime/` | Generalmente sí (2 niveles) |
| Electrobun dev | `eliza-dist/eliza.js` | `apps/app/electrobun/eliza-dist/` | **No** — entra en `apps/` |
| Electrobun empaquetado | `app.asar.unpacked/eliza-dist/eliza.js` | Dentro del bundle `.app` | **No** — sistema de archivos diferente |

En los casos de Electrobun (y a veces el caso de dist compilado dependiendo del comportamiento del bundler), el recorrido nunca alcanza la raíz del repositorio donde están instalados los paquetes `@elizaos/plugin-*`. El import falla con "Cannot find module".

<div id="the-fix-node_path">
## La solución: NODE_PATH
</div>

`NODE_PATH` es una variable de entorno de Node.js que añade directorios extra a la resolución de módulos. La establecemos en **tres lugares** para que cada ruta de entrada resuelva plugins:

<div id="1-srcruntimeelizats-module-level">
### 1. `src/runtime/eliza.ts` (nivel de módulo)
</div>

```ts
const _repoRoot = path.resolve(_elizaDir, "..", "..");
const _rootModules = path.join(_repoRoot, "node_modules");
if (existsSync(_rootModules)) {
  process.env.NODE_PATH = ...;
  Module._initPaths();
}
```

**Por qué aquí:** Cubre `bun run dev` (dev-server.ts importa eliza directamente) y cualquier otro import en proceso de eliza. La guarda `existsSync` significa que esto es un no-op en apps empaquetadas donde la raíz del repositorio no existe.

**Nota sobre `Module._initPaths()`:** Es una API privada de Node.js pero ampliamente usada exactamente para este propósito (mutación de NODE_PATH en runtime). Node cachea las rutas de resolución al inicio; después de establecer `process.env.NODE_PATH` debemos llamarla para que el siguiente `import()` vea las nuevas rutas.

<div id="2-scriptsrun-nodemjs-child-process-env">
### 2. `scripts/run-node.mjs` (env del proceso hijo)
</div>

```js
const rootModules = path.join(cwd, "node_modules");
env.NODE_PATH = ...;
```

**Por qué aquí:** El ejecutor CLI genera un proceso hijo que ejecuta `eliza.mjs` → `dist/entry.js` → `dist/eliza.js`. Establecer `NODE_PATH` en el env del hijo asegura que el hijo resuelva desde la raíz aunque `dist/` no tenga su propio `node_modules`.

<div id="3-appsappelectrobunscrnativeagentts-electrobun-native-runtime">
### 3. `eliza/packages/app-core/platforms/electrobun/src/native/agent.ts` (runtime nativo de Electrobun)
</div>

```ts
// Dev: walk up from __dirname to find node_modules
// Packaged: use ASAR node_modules
```

**Por qué aquí:** El runtime nativo de Electrobun carga `eliza-dist/eliza.js` vía `dynamicImport()`. En modo dev, `__dirname` está profundo dentro de `apps/app/electrobun/build/src/native/` — recorremos hacia arriba para encontrar el primer directorio `node_modules` (la raíz del monorepo). En modo empaquetado, usamos el `node_modules` del ASAR en su lugar.

<div id="why-not-just-use-the-bundler">
## ¿Por qué no simplemente usar el bundler?
</div>

tsdown con `noExternal: [/.*/]` inlinea la mayoría de las dependencias, pero los paquetes `@elizaos/plugin-*` se cargan vía **import dinámico en runtime** (el nombre del plugin viene de la configuración, no de un import estático). El bundler no puede inlinearlos porque no sabe qué plugins se cargarán. Deben ser resolubles en runtime.

<div id="packaged-app-no-op">
## App empaquetada: no-op
</div>

En el `.app` empaquetado, `eliza.js` vive en `app.asar.unpacked/eliza-dist/eliza.js`. Dos niveles arriba está `Contents/Resources/` — no hay `node_modules` ahí. La verificación `existsSync` en `eliza.ts` devuelve false, así que el código de NODE_PATH se omite completamente. La app empaquetada en su lugar copia los paquetes de runtime en `eliza-dist/node_modules` durante la compilación de escritorio (`copy-runtime-node-modules.ts` para Electrobun) y `agent.ts` establece ese directorio `node_modules` empaquetado en `NODE_PATH`.

<div id="bun-and-published-package-exports">
## Bun y exports de paquetes publicados
</div>

Algunos paquetes `@elizaos` (por ejemplo, `@elizaos/plugin-sql`) publican un `package.json` con `exports["."].bun = "./src/index.ts"`. **Por qué lo hacen:** En el monorepo upstream, Bun puede ejecutar TypeScript directamente, por lo que apuntar a `src/` evita un paso de compilación. Sin embargo, el tarball npm publicado solo incluye `dist/` — `src/` no se envía. Cuando instalamos desde npm, la condición `"bun"` apunta a una ruta que no existe.

**Qué sucede:** El resolver de Bun prefiere la condición de exportación `"bun"`. Intenta cargar `./src/index.ts`, el archivo no existe, y obtenemos "Cannot find module … from …/src/runtime/eliza.ts" aunque el paquete está en `node_modules`. Bun no retrocede a la condición `"import"` cuando el objetivo `"bun"` falta.

**Nuestra solución:** `scripts/patch-deps.mjs` se ejecuta después de `bun install` vía `scripts/run-repo-setup.mjs` (usado por `postinstall` y el bootstrap de compilación de la app). Aplica el parche a los paquetes `@elizaos` instalados que lo necesitan y, si `exports["."].bun` apunta a `./src/index.ts` y ese archivo no existe, elimina las condiciones `"bun"` y `"default"` que referencian `src/`. Después del parche, solo quedan `"import"` (y similares), así que Bun resuelve a `./dist/index.js`. **Por qué solo parcheamos cuando falta el archivo:** En un workspace de desarrollo donde el plugin está checkeado con `src/` presente, dejamos el paquete sin cambios para que los flujos de trabajo upstream sigan funcionando.

<div id="pinned-elizaosplugin-openrouter">
## Fijado: `@elizaos/plugin-openrouter`
</div>

Este repositorio actualmente resuelve **`@elizaos/plugin-openrouter`** vía un enlace local del workspace (**`workspace:*`**) durante el desarrollo. Cuando no se usa el checkout local, el `package.json` raíz fija **`2.0.0-alpha.13`** (el tarball npm actual conocido como bueno). **`2.0.0-alpha.12`** envió entrypoints de dist rotos y debe evitarse.

<div id="what-went-wrong-in-200-alpha12">
### Qué salió mal en `2.0.0-alpha.12`
</div>

El tarball npm publicado para **`2.0.0-alpha.12`** contiene salidas JavaScript **truncadas** para los entrypoints ESM de Node y navegador (`dist/node/index.node.js`, `dist/browser/index.browser.js`). Esos archivos solo incluyen los helpers `utils/config` bundleados (~80 líneas). La **implementación principal del plugin** (el objeto que debería exportarse como `openrouterPlugin` y como `default`) **no está presente** en el archivo, pero la lista final `export { … }` aún nombra `openrouterPlugin` y `openrouterPlugin2 as default`.

**Por qué Bun da error:** Cuando el runtime carga el plugin, Bun construye/transpila ese archivo de entrada y falla con errores como *`openrouterPlugin` is not declared in this file* — los símbolos se exportan pero nunca se definen. El build CommonJS (`dist/cjs/index.node.cjs`) está incompleto de la misma manera (los getters de exportación referencian un chunk `import_plugin` faltante).

**Por qué no parcheamos el dist en postinstall:** La release rota le falta el cuerpo entero del plugin, no un solo identificador incorrecto (contrasta con `@elizaos/plugin-pdf`, donde un pequeño string replace arregla un alias de exportación malo). Reconstruir el plugin desde el código fuente dentro de Eliza sería bifurcar upstream y sería frágil. Cuando no estés usando el checkout local del workspace, prefiere el artefacto publicado **`2.0.0-alpha.13`** conocido como bueno.

<div id="maintainer-notes">
### Notas para mantenedores
</div>

- **Antes de actualizar** la dependencia de OpenRouter, verifica el **tarball publicado** en npm: abre `dist/node/index.node.js` y confirma que define el export default / `openrouterPlugin`, o ejecuta `bun build node_modules/@elizaos/plugin-openrouter/dist/node/index.node.js --target=bun` después de instalar.
- **No reemplaces el enlace del workspace con un rango semver sin acotar** hasta que upstream publique una versión corregida y hayas confirmado el artefacto. **Por qué:** `^2.0.0-alpha.10` permitía que Bun resolviera **`alpha.12`**, lo que rompía las instalaciones que actualizaban el lockfile.

El contexto orientado al usuario y la configuración para OpenRouter en sí viven en **[Plugin OpenRouter](plugin-registry/llm/openrouter.md)** (Mintlify: `/plugin-registry/llm/openrouter`).

<div id="optional-plugins-why-was-this-package-in-the-load-set">
## Plugins opcionales: ¿por qué estaba este paquete en el conjunto de carga?
</div>

Los plugins opcionales (y algunos paquetes adyacentes al core) pueden terminar en el conjunto de carga debido a **`plugins.allow`**, **`plugins.entries`**, configuración de **connectors**, **`features.*`**, **variables de entorno** (por ejemplo, claves API de proveedor o claves de wallet que activan la auto-habilitación), o **`plugins.installs`**. Cuando la resolución falla con **módulo npm faltante** o **stagehand de navegador faltante**, el log solía parecer un error genérico de runtime.

**Por qué registramos la procedencia:** `collectPluginNames()` opcionalmente llena un mapa **`PluginLoadReasons`** (primera fuente gana por paquete). `resolvePlugins()` lo pasa; las fallas opcionales benignas se resumen como **`Optional plugins not installed: … (added by: …)`**. Eso responde "¿qué debo cambiar?" — editar config, desactivar env, instalar el paquete, o añadir un checkout del plugin — en lugar de perseguir una hipótesis falsa de "eliza está roto".

**Browser / stagehand:** `@elizaos/plugin-browser` espera un árbol **stagehand-server** que **no está** en el tarball npm. Eliza descubre `plugins/plugin-browser/stagehand-server` **recorriendo padres** desde el runtime para que tanto los checkouts planos de Eliza como los layouts de **submódulo `eliza/`** resuelvan. Ver **[Diagnósticos de desarrollador y espacio de trabajo](/es/guides/developer-diagnostics-and-workspace)**.
