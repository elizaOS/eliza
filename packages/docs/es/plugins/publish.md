---
title: "Publicar un Plugin"
sidebarTitle: "Publicar"
description: "Cómo empaquetar, versionar y publicar un plugin de Eliza en el registro de npm y enviarlo al registro de la comunidad."
---

Esta guía cubre el flujo completo de publicación de un plugin de Eliza — desde el empaquetado hasta la publicación en npm y el envío al registro de la comunidad.

<div id="naming-conventions">

## Convenciones de nomenclatura

</div>

Elige un nombre de paquete que siga la convención establecida:

| Ámbito | Patrón | Ejemplo |
|--------|--------|---------|
| elizaOS oficial | `@elizaos/plugin-{name}` | `@elizaos/plugin-openai` |
| Comunidad (con ámbito) | `@yourorg/plugin-{name}` | `@acme/plugin-analytics` |
| Comunidad (sin ámbito) | `elizaos-plugin-{name}` | `elizaos-plugin-weather` |

El runtime reconoce los tres patrones para el auto-descubrimiento.

<div id="packagejson-requirements">

## Requisitos de package.json

</div>

El `package.json` de tu plugin debe incluir estos campos:

```json
{
  "name": "@elizaos/plugin-my-feature",
  "version": "1.0.0",
  "description": "One-line description of what this plugin does",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "elizaos.plugin.json"],
  "keywords": ["elizaos", "eliza", "plugin"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourorg/plugin-my-feature"
  },
  "peerDependencies": {
    "@elizaos/core": ">=2.0.0-alpha"
  },
  "devDependencies": {
    "@elizaos/core": "alpha",
    "typescript": "^5.0.0"
  }
}
```

**Puntos clave:**
- Declara `@elizaos/core` como `peerDependency` — no como dependencia directa — para evitar conflictos de versión.
- Incluye `elizaos.plugin.json` en `files` para que el manifiesto se publique junto con el código.
- Usa `"type": "module"` para salida ESM.

<div id="build-configuration">

## Configuración de compilación

</div>

Usa TypeScript apuntando a ESM:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

<div id="versioning">

## Versionado

</div>

Sigue el [Versionado Semántico](https://semver.org/):

| Cambio | Incremento |
|--------|------------|
| Nueva acción, proveedor o funcionalidad (compatible hacia atrás) | Minor (`1.0.0` → `1.1.0`) |
| Solo correcciones de errores | Patch (`1.0.0` → `1.0.1`) |
| Cambio de API incompatible | Major (`1.0.0` → `2.0.0`) |

Para plugins dirigidos a la línea de lanzamiento `next` de elizaOS, usa versiones de prelanzamiento:

```bash
npm version prerelease --preid=next
# 1.0.0 → 1.0.1-next.0
```

<div id="publishing-to-npm">

## Publicar en npm

</div>

<div id="1-authenticate">

### 1. Autenticación

</div>

```bash
npm login
```

<div id="2-build">

### 2. Compilación

</div>

```bash
bun run build
```

Verifica que el directorio `dist/` contenga la salida compilada antes de publicar.

<div id="3-dry-run">

### 3. Prueba en seco

</div>

Siempre previsualiza lo que se publicará:

```bash
npm publish --dry-run --access public
```

Comprueba que la salida incluya solo `dist/`, `elizaos.plugin.json`, `package.json` y `README.md`.

<div id="4-publish">

### 4. Publicar

</div>

```bash
npm publish --access public
```

Para versiones de prelanzamiento dirigidas a la línea de lanzamiento `next` de elizaOS:

```bash
npm publish --access public --tag next
```

<div id="5-verify">

### 5. Verificar

</div>

```bash
npm info @yourorg/plugin-my-feature
```

<div id="plugin-manifest">

## Manifiesto del plugin

</div>

Incluye un `elizaos.plugin.json` en la raíz del paquete para una integración enriquecida con la interfaz del panel de administración de Eliza:

```json
{
  "id": "my-feature",
  "name": "My Feature Plugin",
  "description": "Does something useful",
  "version": "1.0.0",
  "kind": "skill",

  "requiredSecrets": ["MY_FEATURE_API_KEY"],
  "optionalSecrets": ["MY_FEATURE_DEBUG"],

  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "endpoint": { "type": "string", "format": "uri" }
    },
    "required": ["apiKey"]
  },

  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "type": "password",
      "sensitive": true
    }
  }
}
```

<div id="best-practices">

## Mejores prácticas

</div>

**Documentación:**
- Incluye un `README.md` con instrucciones de instalación, variables de entorno requeridas y ejemplos de uso.
- Documenta cada acción con una descripción de cuándo el LLM la invocará.
- Lista todas las variables de entorno requeridas y opcionales en una tabla.

**Seguridad:**
- Nunca registres claves de API o secretos — usa `runtime.logger` con cuidado.
- Valida y sanitiza todos los parámetros en los manejadores de acciones.
- Usa `peerDependencies` para `@elizaos/core` para prevenir instalaciones duplicadas.

**Compatibilidad:**
- Prueba contra la versión `next` actual de `@elizaos/core`.
- Declara el rango de versión de tus `peerDependencies` de forma conservadora: `"@elizaos/core": ">=2.0.0"`.
- Exporta un export por defecto compatible con el tipo `Plugin` — no uses exports por defecto para otros propósitos.

**Calidad:**
- Incluye pruebas unitarias con al menos un 80% de cobertura. (Nota: esta es la barra recomendada para plugins publicados independientes. El monorepo aplica un mínimo de 25% de líneas/funciones/sentencias y 15% de ramas desde `scripts/coverage-policy.mjs`.)
- Ejecuta `tsc --noEmit` en CI para detectar errores de tipos.
- Prueba el paquete publicado con `npm pack` antes de publicar.

<div id="multi-language-plugins">

## Plugins multi-lenguaje

</div>

Los plugins pueden incluir implementaciones en múltiples lenguajes:

```
my-plugin/
├── typescript/     # Primary TypeScript implementation
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── python/         # Optional Python SDK bindings
│   ├── src/
│   └── pyproject.toml
├── rust/           # Optional Rust native module
│   ├── src/
│   └── Cargo.toml
└── elizaos.plugin.json
```

La implementación en TypeScript siempre es obligatoria. Las implementaciones en Python y Rust son opcionales y las utilizan sus respectivos SDKs. El manifiesto `elizaos.plugin.json` en la raíz describe el plugin para todos los lenguajes.

<div id="community-registry">

## Registro de la comunidad

</div>

Después de publicar en npm, envía tu plugin al registro de la comunidad abriendo un PR en [`elizaos-plugins/registry`](https://github.com/elizaos-plugins/registry).

Incluye en tu PR:
1. Una entrada en `index.json` que mapee el nombre de tu paquete a su repositorio git
2. Un manifiesto `elizaos.plugin.json` funcional en tu paquete
3. Al menos una suite de pruebas que pase
4. README con instrucciones de configuración y variables de entorno requeridas

Los plugins de la comunidad son revisados en cuanto a seguridad, funcionalidad y calidad de documentación antes de ser listados. Consulta la [Documentación del Registro](/es/plugins/registry#submitting-a-plugin-to-the-registry) para más detalles.

<div id="related">

## Relacionado

</div>

- [Esquemas de Plugins](/es/plugins/schemas) — Referencia completa de esquemas
- [Crear un Plugin](/es/plugins/create-a-plugin) — Construye un plugin desde cero
- [Registro de Plugins](/es/plugins/registry) — Explora plugins publicados
