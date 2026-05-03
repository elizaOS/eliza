---
title: "eliza start"
sidebarTitle: "start"
description: "Iniciar el entorno de ejecución del agente Eliza en modo solo servidor."
---

Inicia el entorno de ejecución del agente elizaOS en modo servidor sin interfaz gráfica. El entorno arranca en modo `serverOnly`, lo que significa que el servidor API y el bucle del agente se inician, pero no se lanza ninguna interfaz de chat interactiva. El comando `run` es un alias directo de `start`.

<div id="usage">

## Uso

</div>

```bash
eliza start
eliza run     # alias for start
```

<div id="options">

## Opciones

</div>

| Flag | Descripción |
|------|-------------|
| `--connection-key [key]` | Establece o genera automáticamente una clave de conexión para acceso remoto. Pasa un valor para usar una clave específica, o pasa el flag sin valor para generar una automáticamente. La clave se establece como `ELIZA_API_TOKEN` para la sesión. Al vincular a una dirección que no sea localhost (por ejemplo, `ELIZA_API_BIND=0.0.0.0`), se genera automáticamente una clave si no hay ninguna configurada. |

Flags globales que también aplican:

| Flag | Descripción |
|------|-------------|
| `-v, --version` | Imprime la versión actual de Eliza y sale |
| `--help`, `-h` | Muestra la ayuda para este comando |
| `--profile <name>` | Usa un perfil de configuración con nombre (el directorio de estado se convierte en `~/.eliza-<name>/`) |
| `--dev` | Atajo para `--profile dev` (también establece el puerto del gateway en `19001`) |
| `--verbose` | Habilita los registros informativos del entorno de ejecución |
| `--debug` | Habilita los registros de nivel de depuración del entorno de ejecución |
| `--no-color` | Desactiva los colores ANSI |

<div id="examples">

## Ejemplos

</div>

```bash
# Start the agent runtime in server mode
eliza start

# Start using the run alias
eliza run

# Start with a named profile (isolated state directory)
eliza --profile production start

# Start with the dev profile
eliza --dev start

# Start with an auto-generated connection key (for remote access)
eliza start --connection-key

# Start with a specific connection key
eliza start --connection-key my-secret-key
```

<div id="behavior">

## Comportamiento

</div>

Cuando ejecutas `eliza start`:

1. El CLI llama a `startEliza({ serverOnly: true })` desde el entorno de ejecución de elizaOS.
2. En producción (`eliza start`), el servidor API se inicia en el puerto `2138` por defecto (se puede sobreescribir con `ELIZA_PORT`). En modo desarrollo (`bun run dev`), la API se ejecuta en el puerto `31337` (`ELIZA_API_PORT`) mientras que la interfaz del panel usa `2138` (`ELIZA_PORT`).
3. El bucle del agente comienza a procesar mensajes de clientes conectados y plataformas de mensajería.
4. No se lanza ninguna interfaz interactiva -- el proceso se ejecuta sin interfaz gráfica.

El comando `run` es un alias directo que llama exactamente a la misma función `startEliza({ serverOnly: true })`.

<div id="environment-variables">

## Variables de entorno

</div>

| Variable | Descripción | Por defecto |
|----------|-------------|-------------|
| `ELIZA_PORT` | Puerto del servidor API | `2138` |
| `ELIZA_STATE_DIR` | Sobreescritura del directorio de estado | `~/.eliza/` |
| `ELIZA_CONFIG_PATH` | Sobreescritura de la ruta del archivo de configuración | `~/.eliza/eliza.json` |

<div id="deployment">

## Despliegue

</div>

`eliza start` es el punto de entrada recomendado para:

- Despliegues en producción
- Contenedores Docker
- Entornos de CI/CD
- Cualquier entorno sin interfaz gráfica o de servidor

Usa tu gestor de procesos preferido para mantener el agente en ejecución:

```bash
# With pm2
pm2 start "eliza start" --name eliza

# With systemd (create a service unit)
ExecStart=/usr/local/bin/eliza start

# In a Dockerfile
CMD ["eliza", "start"]
```

El servidor API admite reinicio en caliente mediante `POST /api/agent/restart` cuando `commands.restart` está habilitado en la configuración.

<div id="related">

## Relacionado

</div>

- [eliza setup](/es/cli/setup) -- inicializa la configuración y el espacio de trabajo antes de iniciar
- [Variables de entorno](/es/cli/environment) -- todas las variables de entorno
- [Configuración](/es/configuration) -- referencia completa del archivo de configuración
