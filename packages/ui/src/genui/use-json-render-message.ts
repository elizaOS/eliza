import type { DataPart } from "@json-render/react";
import { useJsonRenderMessage as officialUseJsonRenderMessage } from "@json-render/react";
import { useMemo } from "react";
import type { ElizaGenUiSpec, ElizaGenUiValidationOptions } from "./types";

type MessagePart =
  | { type: "text"; text: string }
  | { type: "data-spec"; data?: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

type UseJsonRenderMessageResult = {
  spec: ElizaGenUiSpec | null;
  hasSpec: boolean;
  text: string;
};

function toDataParts(
  parts: readonly MessagePart[] | null | undefined,
): DataPart[] {
  if (!parts) return [];
  return Array.from(parts) as unknown as DataPart[];
}

export function useJsonRenderMessage(
  parts: readonly MessagePart[] | null | undefined,
  _validationOptions?: ElizaGenUiValidationOptions,
): UseJsonRenderMessageResult {
  const dataParts = useMemo(() => toDataParts(parts), [parts]);

  const officialResult = officialUseJsonRenderMessage(dataParts);

  return useMemo(() => {
    const { spec: officialSpec, text: officialText, hasSpec } = officialResult;

    if (!hasSpec || !officialSpec) {
      return { spec: null, hasSpec: false, text: officialText ?? "" };
    }

    const { root, elements, state } = officialSpec;
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

    const spec: ElizaGenUiSpec = {
      version: "0.1",
      root: root ?? "",
      components,
      data: state as Record<string, unknown> | undefined,
    } as ElizaGenUiSpec;

    return { spec, hasSpec: true, text: officialText ?? "" };
  }, [officialResult]);
}

export { officialUseJsonRenderMessage as useOfficialJsonRenderMessage };
