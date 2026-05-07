import {
  getActiveRoutingContextsForTurn,
  type IAgentRuntime,
  type Memory,
  type State,
} from '@elizaos/core';
import { N8N_WORKFLOW_SERVICE_TYPE } from '../services/index';

const N8N_CONTEXTS = ['automation', 'connectors', 'tasks'] as const;

const WORKFLOW_KEYWORDS = [
  'n8n',
  'workflow',
  'workflows',
  'automation',
  'activate',
  'enable',
  'start',
  'deactivate',
  'disable',
  'stop',
  'pause',
  'delete',
  'remove',
  'create',
  'build',
  'deploy',
  'modify',
  'edit',
  'update',
  'flujo',
  'automatización',
  'activar',
  'desactivar',
  'eliminar',
  'créer',
  'modifier',
  'automatisation',
  'supprimer',
  'arbeitsablauf',
  'automatisierung',
  'löschen',
  'flusso',
  'automazione',
  'attivare',
  'eliminare',
  'fluxo',
  'automação',
  'ativar',
  'excluir',
  '工作流',
  '自动化',
  '启用',
  '禁用',
  '删除',
  'ワークフロー',
  '自動化',
  '有効',
  '無効',
  '削除',
] as const;

function hasN8nContext(message: Memory, state?: State): boolean {
  const active = new Set(
    getActiveRoutingContextsForTurn(state, message).map((context) =>
      `${context}`.toLowerCase(),
    ),
  );
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) {return;}
    for (const item of value) {
      if (typeof item === 'string') {active.add(item.toLowerCase());}
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  return N8N_CONTEXTS.some((context) => active.has(context));
}

function hasN8nKeyword(message: Memory, state?: State): boolean {
  const text = [
    typeof message.content?.text === 'string' ? message.content.text : '',
    typeof state?.values?.recentMessages === 'string'
      ? state.values.recentMessages
      : '',
  ]
    .join('\n')
    .toLowerCase();
  return WORKFLOW_KEYWORDS.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

export function validateN8nWorkflowIntent(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
): boolean {
  return (
    Boolean(runtime.getService(N8N_WORKFLOW_SERVICE_TYPE)) &&
    (hasN8nContext(message, state) || hasN8nKeyword(message, state))
  );
}
