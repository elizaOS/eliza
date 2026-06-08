import type { Spec as OfficialSpec } from "@json-render/core";
import { useUIStream as officialUseUIStream } from "@json-render/react";
import { useCallback, useMemo } from "react";
import type {
  ElizaGenUiSendOptions,
  ElizaGenUiSpec,
  ElizaGenUiStreamOptions,
  ElizaGenUiStreamState,
} from "./types";

export function officialSpecToEliza(
  spec: OfficialSpec | null,
): ElizaGenUiSpec | null {
  if (!spec) return null;
  const { root, elements, state } = spec;
  const components = Object.entries(elements).map(([id, el]) => {
    const record = el as unknown as Record<string, unknown>;
    const type = record.type as string | undefined;
    const props = record.props as Record<string, unknown> | undefined;
    const children = record.children as string[] | undefined;
    return {
      id,
      component: type ?? "unknown",
      ...(children ? { children } : {}),
      ...(props ? (props as Record<string, unknown>) : {}),
    };
  }) as unknown as ElizaGenUiSpec["components"];
  return {
    version: "0.1",
    root: root ?? "",
    components,
    data: state as Record<string, unknown> | undefined,
  } as ElizaGenUiSpec;
}

export function useUIStream(
  options: ElizaGenUiStreamOptions,
): ElizaGenUiStreamState & {
  send: (sendOptions?: ElizaGenUiSendOptions) => Promise<void>;
  reset: () => void;
} {
  const { api, headers = {}, body: initialBody, onError, onComplete } = options;

  const official = officialUseUIStream({
    api,
    onError,
    onComplete: onComplete
      ? (spec: OfficialSpec) => {
          onComplete(spec as unknown as ElizaGenUiSpec | null);
        }
      : undefined,
  });

  const spec = useMemo(
    () => officialSpecToEliza(official.spec),
    [official.spec],
  );

  const send = useCallback(
    async (sendOptions?: ElizaGenUiSendOptions) => {
      await official.send(sendOptions?.prompt ?? "", {
        previousSpec: official.spec,
        ...initialBody,
        ...sendOptions?.body,
        ...(headers ? { headers } : {}),
      });
    },
    [official.send, initialBody, headers, official.spec],
  );

  const reset = useCallback(() => {
    official.clear();
  }, [official.clear]);

  return {
    spec,
    isStreaming: official.isStreaming,
    error: official.error,
    send,
    reset,
  };
}
