---
title: "milady start"
sidebarTitle: "start"
description: "Iniciar el entorno de ejecución del agente Milady en modo solo servidor."
---

Inicia el entorno de ejecución del agente elizaOS en modo servidor sin interfaz gráfica. El entorno arranca en modo `serverOnly`, lo que significa que el servidor API y el bucle del agente se inician, pero no se lanza ninguna interfaz de chat interactiva. El comando `run` es un alias directo de `start`.

<div id="usage">

## Uso

</div>

```bash
milady start
milady run     # alias for start
```

<div id="options">

## Opciones

</div>

| Flag | Descripción |
|------|-------------|
| `--connection-key [key]` | Establece o genera automáticamente una clave de conexión para acceso remoto. Pasa un valor para usar una clave específica, o pasa el flag sin valor para generar una automáticamente. La clave se establece como `MILADY_API_TOKEN` para la sesión. Al vincular a una dirección que no sea localhost (por ejemplo, `MILADY_API_BIND=0.0.0.0`), se genera automáticamente una clave si no hay ninguna configurada. |

Flags globales que también aplican:

| Flag | Descripción |
|------|-------------|
| `-v, --version` | Imprime la versión actual de Milady y sale |
| `--help`, `-h` | Muestra la ayuda para este comando |
| `--profile <name>` | Usa un perfil de configuración con nombre (el directorio de estado se convierte en `~/.milady-<name>/`) |
| `--dev` | Atajo para `--profile dev` (también establece el puerto del gateway en `19001`) |
| `--verbose` | Habilita los registros informativos del entorno de ejecución |
| `--debug` | Habilita los registros de nivel de depuración del entorno de ejecución |
| `--no-color` | Desactiva los colores ANSI |

<div id="examples">

## Ejemplos

</div>

```bash
# Start the agent runtime in server mode
milady start

# Start using the run alias
milady run

# Start with a named profile (isolated state directory)
milady --profile production start

# Start with the dev profile
milady --dev start

# Start with an auto-generated connection key (for remote access)
milady start --connection-key

# Start with a specific connection key
milady start --connection-key my-secret-key
```

<div id="behavior">

## Comportamiento

</div>

Cuando ejecutas `milady start`:

1. El CLI llama a `startEliza({ serverOnly: true })` desde el entorno de ejecución de elizaOS.
2. En producción (`milady start`), el servidor API se inicia en el puerto `2138` por defecto (se puede sobreescribir con `MILADY_PORT` o `ELIZA_PORT`). En modo desarrollo (`bun run dev`), la API se ejecuta en el puerto `31337` (`MILADY_API_PORT`) mientras que la interfaz del panel usa `2138` (`MILADY_PORT`).
3. El bucle del agente comienza a procesar mensajes de clientes conectados y plataformas de mensajería.
4. No se lanza ninguna interfaz interactiva -- el proceso se ejecuta sin interfaz gráfica.

El comando `run` es un alias directo que llama exactamente a la misma función `startEliza({ serverOnly: true })`.

<div id="environment-variables">

## Variables de entorno

</div>

| Variable | Descripción | Por defecto |
|----------|-------------|-------------|
| `MILADY_PORT` | Puerto del servidor API (también acepta `ELIZA_PORT` como alternativa) | `2138` |
| `MILADY_STATE_DIR` | Sobreescritura del directorio de estado | `~/.milady/` |
| `MILADY_CONFIG_PATH` | Sobreescritura de la ruta del archivo de configuración | `~/.milady/milady.json` |

<div id="deployment">

## Despliegue

</div>

`milady start` es el punto de entrada recomendado para:

- Despliegues en producción
- Contenedores Docker
- Entornos de CI/CD
- Cualquier entorno sin interfaz gráfica o de servidor

Usa tu gestor de procesos preferido para mantener el agente en ejecución:

```bash
# With pm2
pm2 start "milady start" --name milady

# With systemd (create a service unit)
ExecStart=/usr/local/bin/milady start

# In a Dockerfile
CMD ["milady", "start"]
```

El servidor API admite reinicio en caliente mediante `POST /api/agent/restart` cuando `commands.restart` está habilitado en la configuración.

<div id="related">

## Relacionado

</div>

- [milady setup](/es/cli/setup) -- inicializa la configuración y el espacio de trabajo antes de iniciar
- [Variables de entorno](/es/cli/environment) -- todas las variables de entorno
- [Configuración](/es/configuration) -- referencia completa del archivo de configuración
