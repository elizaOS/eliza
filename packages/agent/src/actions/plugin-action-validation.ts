import type { Memory, State } from "@elizaos/core";
import { hasSelectedContextOrSignalSync } from "./context-signal.js";

const PLUGIN_ADMIN_CONTEXTS = ["admin", "settings", "connectors"] as const;
const PLUGIN_CODE_CONTEXTS = ["admin", "settings", "code", "files"] as const;

const INSTALL_PLUGIN_TERMS = [
  "install plugin",
  "add plugin",
  "enable plugin",
  "setup plugin",
  "set up plugin",
  "connect plugin",
  "integration",
  "connector",
  "安装插件",
  "启用插件",
  "插件",
  "플러그인 설치",
  "플러그인",
  "instalar plugin",
  "activar plugin",
  "conector",
  "instalar plugin",
  "ativar plugin",
  "conector",
  "cài plugin",
  "cai plugin",
  "bật plugin",
  "bat plugin",
  "mag-install ng plugin",
  "i-enable ang plugin",
];

const EJECT_PLUGIN_TERMS = [
  "eject plugin",
  "fork plugin",
  "clone plugin",
  "edit plugin source",
  "local plugin source",
  "patch plugin",
  "导出插件",
  "克隆插件",
  "编辑插件",
  "플러그인 포크",
  "플러그인 소스",
  "expulsar plugin",
  "clonar plugin",
  "editar fuente del plugin",
  "ejetar plugin",
  "clonar plugin",
  "editar código do plugin",
  "sao chép plugin",
  "sao chep plugin",
  "chỉnh sửa plugin",
  "chinh sua plugin",
  "i-fork ang plugin",
  "i-clone ang plugin",
];

const REINJECT_PLUGIN_TERMS = [
  "reinject plugin",
  "uneject plugin",
  "restore plugin",
  "remove local plugin",
  "discard plugin edits",
  "published plugin",
  "npm version",
  "恢复插件",
  "还原插件",
  "删除本地插件",
  "플러그인 복원",
  "되돌리기",
  "restaurar plugin",
  "quitar plugin local",
  "versión npm",
  "versao npm",
  "phiên bản npm",
  "phien ban npm",
  "ibalik ang plugin",
  "alisin ang local plugin",
];

const SYNC_PLUGIN_TERMS = [
  "sync plugin",
  "update plugin",
  "pull plugin upstream",
  "merge upstream",
  "latest plugin",
  "fetch plugin changes",
  "同步插件",
  "更新插件",
  "上游",
  "플러그인 동기화",
  "업스트림",
  "sincronizar plugin",
  "actualizar plugin",
  "upstream",
  "sincronizar plugin",
  "atualizar plugin",
  "đồng bộ plugin",
  "dong bo plugin",
  "cập nhật plugin",
  "cap nhat plugin",
  "i-sync ang plugin",
  "i-update ang plugin",
];

const GENERIC_PLUGIN_TERMS = ["plugin", "plugins", "插件", "플러그인"];

export function hasInstallPluginSignal(
  message: Memory,
  state: State | undefined,
): boolean {
  return hasSelectedContextOrSignalSync(
    message,
    state,
    PLUGIN_ADMIN_CONTEXTS,
    INSTALL_PLUGIN_TERMS,
    GENERIC_PLUGIN_TERMS,
  );
}

export function hasEjectPluginSignal(
  message: Memory,
  state: State | undefined,
): boolean {
  return hasSelectedContextOrSignalSync(
    message,
    state,
    PLUGIN_CODE_CONTEXTS,
    EJECT_PLUGIN_TERMS,
    GENERIC_PLUGIN_TERMS,
  );
}

export function hasReinjectPluginSignal(
  message: Memory,
  state: State | undefined,
): boolean {
  return hasSelectedContextOrSignalSync(
    message,
    state,
    PLUGIN_CODE_CONTEXTS,
    REINJECT_PLUGIN_TERMS,
    GENERIC_PLUGIN_TERMS,
  );
}

export function hasSyncPluginSignal(
  message: Memory,
  state: State | undefined,
): boolean {
  return hasSelectedContextOrSignalSync(
    message,
    state,
    PLUGIN_CODE_CONTEXTS,
    SYNC_PLUGIN_TERMS,
    GENERIC_PLUGIN_TERMS,
  );
}
