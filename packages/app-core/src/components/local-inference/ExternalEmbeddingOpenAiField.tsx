import { Button, Label } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import type { ExternalLlmRuntimeRow } from "../../api/client-local-inference";

type Props = {
  stackRow: ExternalLlmRuntimeRow;
  candidateModelIds: string[];
  /** Current `OPENAI_EMBEDDING_MODEL` from agent config (trimmed). */
  configuredModel: string;
  onAfterSave?: () => void | Promise<void>;
};

/**
 * Binds `OPENAI_EMBEDDING_MODEL` to an id returned by the active local stack’s
 * probe (LM Studio / vLLM / Jan / Ollama OpenAI-compat). One id → read-only +
 * optional save; several → &lt;select&gt;.
 */
export function ExternalEmbeddingOpenAiField({
  stackRow,
  candidateModelIds,
  configuredModel,
  onAfterSave,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [localConfigured, setLocalConfigured] = useState(configuredModel);

  useEffect(() => {
    setLocalConfigured(configuredModel);
  }, [configuredModel]);

  const persist = useCallback(
    async (next: string) => {
      setBusy(true);
      try {
        await client.updateConfig({
          env: { vars: { OPENAI_EMBEDDING_MODEL: next } },
        });
        setLocalConfigured(next);
        await onAfterSave?.();
      } finally {
        setBusy(false);
      }
    },
    [onAfterSave],
  );

  if (candidateModelIds.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No embedding-looking model ids were returned for {stackRow.displayName}.
        Load an embedding model there, then refresh hub status (↻ on Local AI
        cards).
      </p>
    );
  }

  const only = candidateModelIds[0];
  if (only === undefined) {
    return null;
  }
  const configuredMatches =
    Boolean(localConfigured) && candidateModelIds.includes(localConfigured);
  const selectValue = configuredMatches ? localConfigured : "";

  if (candidateModelIds.length === 1) {
    return (
      <div className="space-y-2">
        <div>
          <Label className="text-xs font-medium text-muted-foreground">
            Embedding model
          </Label>
          <div className="mt-1 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm font-mono text-foreground break-all">
            {only}
          </div>
        </div>
        {localConfigured === only ? (
          <p className="text-[11px] text-muted-foreground">
            <span className="font-mono">OPENAI_EMBEDDING_MODEL</span> is set to
            this id.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
              This is the only embedding-shaped id {stackRow.displayName}{" "}
              listed. Save it to{" "}
              <span className="font-mono">OPENAI_EMBEDDING_MODEL</span> so the
              OpenAI-compatible embedding plugin matches LM Studio.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 rounded-lg"
              disabled={busy}
              onClick={() => void persist(only)}
            >
              {busy ? "Saving…" : "Save to agent config"}
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-muted-foreground">
        Embedding model (
        <span className="font-mono">OPENAI_EMBEDDING_MODEL</span>)
      </Label>
      <select
        className="mt-1 w-full rounded-md border border-border bg-bg/50 px-2 py-1.5 text-sm font-mono"
        disabled={busy}
        value={selectValue}
        onChange={(e) => void persist(e.target.value)}
      >
        <option value="">— choose —</option>
        {candidateModelIds.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      {configuredMatches ? (
        <p className="text-[11px] text-muted-foreground">
          Saved to agent config. Restart or reload plugins if embeddings do not
          pick it up immediately.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Pick an id that matches a model loaded in {stackRow.displayName}.
        </p>
      )}
    </div>
  );
}
