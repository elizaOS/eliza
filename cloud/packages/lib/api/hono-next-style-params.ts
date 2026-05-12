/**
 * Build a Next.js 15–shaped `{ params: Promise<...> }` from Hono `c.req.param`
 * so legacy route handlers can stay unchanged during the Workers migration.
 */

import type { Context } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

export type RouteParamEntry = { readonly name: string; readonly splat: boolean };

type ParamsFromSpec<TSpec extends readonly RouteParamEntry[]> = {
  [Entry in TSpec[number] as Entry["name"]]: Entry["splat"] extends true ? string[] : string;
};

export function nextStyleParams<const TSpec extends readonly RouteParamEntry[]>(
  c: Context<AppEnv>,
  spec: TSpec,
): { params: Promise<ParamsFromSpec<TSpec>> } {
  const obj: Record<string, string | string[]> = {};
  for (const { name, splat } of spec) {
    if (splat) {
      const raw = c.req.param("*") ?? "";
      obj[name] = raw === "" ? [] : raw.split("/").filter((s) => s.length > 0);
    } else {
      const v = c.req.param(name);
      if (v !== undefined) obj[name] = v;
    }
  }
  return { params: Promise.resolve(obj as ParamsFromSpec<TSpec>) };
}
