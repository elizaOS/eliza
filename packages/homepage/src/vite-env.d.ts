/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ELIZACLOUD_API_URL?: string;
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
  readonly VITE_TELEGRAM_BOT_ID?: string;
  readonly VITE_WHATSAPP_PHONE_NUMBER?: string;
  readonly VITE_DISCORD_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
