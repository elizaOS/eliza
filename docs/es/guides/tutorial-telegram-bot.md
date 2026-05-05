---
title: "Tutorial: Bot de Telegram"
sidebarTitle: "Configuración del bot de Telegram"
description: "Aprende a crear y configurar un bot de Telegram con Eliza en solo unos minutos"
---

<div id="tutorial-telegram-bot">
# Tutorial: Bot de Telegram
</div>

Comienza con la integración del bot de Telegram de Eliza. Este tutorial te guía a través de la creación de tu primer bot, su configuración y las pruebas de extremo a extremo.

<Info>
  Este tutorial asume que tienes Eliza instalado. Si aún no lo has hecho, consulta la [Guía de instalación](/es/installation).
</Info>

<div id="prerequisites">
## Requisitos previos
</div>

Antes de comenzar, asegúrate de tener:

- Una cuenta de Telegram
- Eliza instalado y en ejecución (`bun run dev`)
- Acceso al panel de control de Eliza (por defecto: http://localhost:2138)

<div id="quick-setup-via-dashboard">
## Configuración rápida a través del panel de control
</div>

La forma más rápida de configurar el conector de Telegram es a través del panel de control de Eliza:

1. Abre **http://localhost:2138** en tu navegador
2. Navega a **Connectors** en la barra de navegación superior
3. Encuentra **Telegram** en la lista de conectores y actívalo (**ON**)
4. Pega tu **Bot Token** (consulta más abajo cómo obtener uno)
5. Haz clic en **Save Settings** — el agente se reiniciará automáticamente
6. Haz clic en **Test Connection** para verificar — deberías ver "Connected as @yourbotname"
7. Abre Telegram, busca tu bot por nombre de usuario y envía `/start`

Eso es todo — tu bot está activo.

<div id="getting-a-bot-token-from-botfather">
## Obtener un token de bot de BotFather
</div>

<Steps>
  <Step title="Crear un bot con BotFather">
    Abre Telegram y busca **@BotFather**, el bot oficial para crear bots de Telegram.

    1. Inicia una conversación con @BotFather haciendo clic en el botón "Start"
    2. Envía el comando: `/newbot`
    3. BotFather te pedirá que elijas un nombre para tu bot (este es el nombre para mostrar)
    4. Elige un nombre de usuario único para tu bot (debe terminar en "bot")
    5. BotFather responderá con tu **bot token** — guárdalo en un lugar seguro

    <Warning>
      Nunca compartas tu token de bot públicamente ni lo incluyas en el control de versiones. Otorga acceso completo a tu bot.
    </Warning>

    Tu token tendrá un aspecto similar a: `123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI`
  </Step>

  <Step title="Recuperar un token existente">
    Si ya tienes un bot, puedes recuperar el token en cualquier momento:

    1. Envía un mensaje a @BotFather con `/mybots`
    2. Selecciona tu bot de la lista
    3. Selecciona "API Token"

    Para regenerar un token comprometido, selecciona "Revoke current token" en el mismo menú. Esto invalida inmediatamente el token anterior.
  </Step>
</Steps>

<div id="dashboard-features">
## Funciones del panel de control
</div>

<div id="test-connection">
### Probar conexión
</div>

Después de guardar tu token de bot, haz clic en **Test Connection** en la configuración del conector. Esto llama a la API de Telegram `getMe` y verifica que tu token sea válido. Verás uno de estos resultados:

- **"Connected as @yourbotname"** — tu bot está listo
- **"Telegram API error: ..."** — verifica tu token

<div id="chat-access-toggle">
### Control de acceso a chats
</div>

De forma predeterminada, tu bot está configurado en **Allow all chats** — cualquier persona que le envíe un mensaje recibirá una respuesta. Para restringir el acceso:

1. Haz clic en el botón **Allow all chats** para cambiar a **Allow only specific chats**
2. Aparecerá un campo de entrada — introduce un arreglo JSON de IDs de chat permitidos, por ejemplo:
   ```json
   ["123456789", "-1001234567890"]
   ```
3. Haz clic en **Save Settings**

Para volver al modo anterior, haz clic en el botón de nuevo para regresar a **Allow all chats** — tus IDs de chat guardados previamente se restaurarán si vuelves a cambiar a chats específicos.

Formatos de ID de chat:
- **Números positivos** (ej. `123456789`) — chats privados con usuarios individuales
- **Números negativos que comienzan con -100** (ej. `-1001234567890`) — grupos y supergrupos

Para encontrar tu ID de chat, usa [@userinfobot](https://t.me/userinfobot) en Telegram.

Los cambios en los chats permitidos surten efecto inmediatamente — no es necesario reiniciar.

<div id="show--hide-token">
### Mostrar / Ocultar token
</div>

Haz clic en el botón **Show** junto al campo Bot Token para revelar el valor del token guardado. Haz clic en **Hide** para ocultarlo de nuevo.

<div id="reset">
### Restablecer
</div>

Haz clic en **Reset** para borrar toda la configuración guardada de Telegram (token, chats permitidos, etc.). Esto pedirá confirmación y reiniciará el agente. Deberás reconfigurar el conector después.

<div id="advanced-settings">
### Configuración avanzada
</div>

Haz clic en **Advanced** para expandir la configuración adicional:

- **API Root** — Endpoint personalizado de la API de bots de Telegram (por defecto: `https://api.telegram.org`). Solo es necesario si ejecutas un [servidor de API de bots local](https://core.telegram.org/bots/api#using-a-local-bot-api-server) o usas un proxy.
- **Test Chat ID** — ID de chat utilizado por el conjunto de pruebas automatizadas. No es necesario para producción.

<div id="configuration-via-elizajson">
## Configuración a través de eliza.json
</div>

También puedes configurar el conector de Telegram directamente en `~/.eliza/eliza.json`:

```json
{
  "env": {
    "TELEGRAM_BOT_TOKEN": "123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI"
  }
}
```

O usa un archivo `.env` en la raíz de tu proyecto:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI
```

Luego inicia Eliza:

```bash
bun run dev
```

<div id="configuration-parameters">
## Parámetros de configuración
</div>

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| **Bot Token** (`TELEGRAM_BOT_TOKEN`) | Sí | Token de autenticación de @BotFather. Este es el único parámetro necesario para comenzar. |
| **Allowed Chats** (`TELEGRAM_ALLOWED_CHATS`) | No | Arreglo JSON de IDs de chat con los que el bot puede interactuar. Si no se establece, el bot responde a todos los chats. |
| **API Root** (`TELEGRAM_API_ROOT`) | No | Endpoint personalizado de la API de bots de Telegram. Por defecto es `https://api.telegram.org`. |
| **Test Chat ID** (`TELEGRAM_TEST_CHAT_ID`) | No | ID de chat utilizado por el conjunto de pruebas E2E. No es necesario para producción. |

<div id="troubleshooting">
## Solución de problemas
</div>

<AccordionGroup>
  <Accordion title="El token del bot no es válido o no funciona">
    **Problema:** Obtienes un error como "Unauthorized" o el botón Test Connection muestra "Telegram API error"

    **Soluciones:**
    1. Verifica que hayas copiado el token completo correctamente
    2. Confirma que el token no haya sido revocado — consulta `/mybots` en BotFather
    3. Asegúrate de que no haya espacios o saltos de línea adicionales
    4. Regenera el token en BotFather si es necesario (esto invalida el anterior)
    5. Después de pegar un nuevo token, haz clic en **Save Settings** y luego en **Test Connection**
  </Accordion>

  <Accordion title="La insignia NEEDS SETUP no desaparece">
    **Problema:** El conector de Telegram muestra "Needs setup" aunque el token esté guardado

    **Soluciones:**
    1. Solo el **Bot Token** es obligatorio — los demás campos son opcionales
    2. Haz clic en **Save Settings** para guardar tu token
    3. Actualiza la página — la insignia debería cambiar a "Ready"
    4. Si la insignia persiste, revisa los mensajes de error en la terminal
  </Accordion>

  <Accordion title="El bot no recibe mensajes">
    **Problema:** Envías mensajes pero el bot no responde

    **Soluciones:**
    1. Verifica que el conector esté activado (**ON**) en el panel de control
    2. Comprueba que Test Connection muestre "Connected as @yourbotname"
    3. Busca mensajes de error en la terminal donde se ejecuta Eliza
    4. Si el acceso a chats está restringido, verifica que tu ID de chat esté en la lista permitida
    5. Asegúrate de haber enviado `/start` al bot primero
    6. Intenta reiniciar Eliza — el conector podría necesitar un reinicio
  </Accordion>

  <Accordion title="El bot responde lentamente">
    **Problema:** Los mensajes se retrasan o el bot parece no responder

    **Soluciones:**
    1. Verifica tu conexión a internet
    2. Monitorea los recursos del sistema — la RAM o CPU podrían estar al máximo
    3. Revisa los registros de Eliza en busca de errores o procesos bloqueados
    4. Para producción, considera el modo webhook en lugar de polling
  </Accordion>

  <Accordion title="Error 409 Conflict en los registros">
    **Problema:** Los registros muestran "409: Conflict: terminated by other getUpdates request"

    **Soluciones:**
    1. Asegúrate de que solo una instancia de Eliza esté en ejecución
    2. Busca procesos de bot obsoletos: `tasklist | grep bun` (Windows) o `ps aux | grep bun` (Linux/Mac)
    3. Espera 30 segundos y reinicia — Telegram necesita tiempo para liberar el slot de polling
  </Accordion>
</AccordionGroup>

<div id="next-steps">
## Próximos pasos
</div>

- **[Guía de conectores](../guides/connectors.md)** — Descripción general de todos los conectores disponibles
- **[Guía de configuración](../guides/config-templates.md)** — Opciones de configuración avanzada
- **[Guía de despliegue](../guides/deployment.md)** — Despliega tu bot en producción

<div id="need-help">
## ¿Necesitas ayuda?
</div>

- Únete a la [Comunidad Discord de Eliza](https://discord.gg/eliza)
- Reporta problemas en [GitHub](https://github.com/eliza-ai/eliza/issues)
