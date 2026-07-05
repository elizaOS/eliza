/**
 * Create / edit dialog for a user-owned MCP server.
 *
 * Drives the real registry CRUD: `POST /api/v1/mcps` (create) and
 * `PUT /api/v1/mcps/:mcpId` (edit) via {@link useCreateMcp} / {@link useUpdateMcp}.
 *
 * Scope note: this form configures **external-endpoint** MCPs end-to-end (the
 * path a user can fully complete from this surface). Container-backed MCPs need
 * a deployed container id from the containers/deploy flow, so the form keeps the
 * existing endpoint for an edit of a container MCP but does not expose container
 * selection here (a `containerId` picker is a follow-up tied to that surface).
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BrandButton } from "../../cloud-ui/components/brand/brand-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { ApiError } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import type {
  CreateUserMcpInput,
  McpCategory,
  McpPricingType,
  McpTool,
  UpdateUserMcpInput,
  UserMcpRecord,
} from "./lib/api-types";
import { useCreateMcp, useUpdateMcp } from "./lib/mcp-mutations";

const CATEGORIES: McpCategory[] = [
  "utilities",
  "finance",
  "data",
  "communication",
  "productivity",
  "ai",
  "search",
  "platform",
  "other",
];

const PRICING_TYPES: McpPricingType[] = ["free", "credits", "x402"];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

interface FormState {
  name: string;
  slug: string;
  description: string;
  category: McpCategory;
  externalEndpoint: string;
  endpointPath: string;
  pricingType: McpPricingType;
  creditsPerRequest: string;
  x402PriceUsd: string;
  x402Enabled: boolean;
  toolsText: string;
  documentationUrl: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    slug: "",
    description: "",
    category: "utilities",
    externalEndpoint: "",
    endpointPath: "/mcp",
    pricingType: "credits",
    creditsPerRequest: "1",
    x402PriceUsd: "0.0001",
    x402Enabled: false,
    toolsText: "",
    documentationUrl: "",
  };
}

function formFromRecord(mcp: UserMcpRecord): FormState {
  return {
    name: mcp.name,
    slug: mcp.slug,
    description: mcp.description,
    category: (mcp.category as McpCategory) ?? "utilities",
    externalEndpoint: mcp.external_endpoint ?? "",
    endpointPath: mcp.endpoint_path ?? "/mcp",
    pricingType: mcp.pricing_type,
    creditsPerRequest: mcp.credits_per_request ?? "1",
    x402PriceUsd: mcp.x402_price_usd ?? "0.0001",
    x402Enabled: mcp.x402_enabled,
    toolsText: mcp.tools.map((t) => `${t.name}: ${t.description}`).join("\n"),
    documentationUrl: mcp.documentation_url ?? "",
  };
}

/** Parse the "name: description" textarea into the MCP tools array. */
function parseTools(text: string): McpTool[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) return { name: line, description: line };
      return {
        name: line.slice(0, idx).trim(),
        description: line.slice(idx + 1).trim() || line.slice(0, idx).trim(),
      };
    });
}

interface McpEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this MCP; otherwise it creates a new one. */
  editing?: UserMcpRecord | null;
}

export function McpEditorDialog({
  open,
  onOpenChange,
  editing,
}: McpEditorDialogProps) {
  const t = useCloudT();
  const create = useCreateMcp();
  const update = useUpdateMcp();
  const isEdit = !!editing;
  const submitting = create.isPending || update.isPending;

  const [form, setForm] = useState<FormState>(emptyForm);
  const [slugTouched, setSlugTouched] = useState(false);

  // Re-seed the form whenever the dialog opens (create vs edit target changes).
  useEffect(() => {
    if (!open) return;
    setForm(editing ? formFromRecord(editing) : emptyForm());
    setSlugTouched(!!editing);
  }, [open, editing]);

  const update_ = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const tools = useMemo(() => parseTools(form.toolsText), [form.toolsText]);

  const valid =
    form.name.trim().length > 0 &&
    form.description.trim().length > 0 &&
    (isEdit || form.slug.trim().length > 0) &&
    (isEdit || form.externalEndpoint.trim().length > 0);

  const onSubmit = async () => {
    try {
      if (isEdit && editing) {
        const input: UpdateUserMcpInput = {
          name: form.name.trim(),
          description: form.description.trim(),
          category: form.category,
          endpointPath: form.endpointPath.trim() || undefined,
          tools,
          pricingType: form.pricingType,
          creditsPerRequest:
            form.pricingType === "credits"
              ? Number(form.creditsPerRequest) || 0
              : undefined,
          x402PriceUsd:
            form.pricingType === "x402"
              ? Number(form.x402PriceUsd) || 0
              : undefined,
          x402Enabled: form.x402Enabled,
          documentationUrl: form.documentationUrl.trim() || null,
        };
        await update.mutateAsync({ mcpId: editing.id, input });
        toast.success(t("cloud.mcps.updated", { defaultValue: "MCP updated" }));
      } else {
        const input: CreateUserMcpInput = {
          name: form.name.trim(),
          slug: form.slug.trim(),
          description: form.description.trim(),
          category: form.category,
          endpointType: "external",
          externalEndpoint: form.externalEndpoint.trim(),
          endpointPath: form.endpointPath.trim() || undefined,
          tools,
          pricingType: form.pricingType,
          creditsPerRequest:
            form.pricingType === "credits"
              ? Number(form.creditsPerRequest) || 0
              : undefined,
          x402PriceUsd:
            form.pricingType === "x402"
              ? Number(form.x402PriceUsd) || 0
              : undefined,
          x402Enabled: form.x402Enabled,
          documentationUrl: form.documentationUrl.trim() || undefined,
        };
        await create.mutateAsync(input);
        toast.success(
          t("cloud.mcps.created", { defaultValue: "MCP created" }),
          {
            description: t("cloud.mcps.createdDesc", {
              defaultValue:
                "Publish it to make it discoverable in the registry.",
            }),
          },
        );
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(
        isEdit
          ? t("cloud.mcps.updateFailed", {
              defaultValue: "Failed to update MCP",
            })
          : t("cloud.mcps.createFailed", {
              defaultValue: "Failed to create MCP",
            }),
        { description: errorMessage(error) },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("cloud.mcps.editTitle", { defaultValue: "Edit MCP server" })
              : t("cloud.mcps.createTitle", {
                  defaultValue: "Register MCP server",
                })}
          </DialogTitle>
          <DialogDescription>
            {t("cloud.mcps.editDescription", {
              defaultValue:
                "Register an external MCP endpoint so your agents and the registry can use it.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          <div className="grid gap-2">
            <Label htmlFor="mcp-name">
              {t("cloud.mcps.nameLabel", { defaultValue: "Name" })}
            </Label>
            <Input
              id="mcp-name"
              value={form.name}
              autoFocus
              placeholder={t("cloud.mcps.namePlaceholder", {
                defaultValue: "Weather Tools",
              })}
              onChange={(e) => {
                const name = e.target.value;
                update_("name", name);
                if (!isEdit && !slugTouched) update_("slug", slugify(name));
              }}
            />
          </div>

          {!isEdit && (
            <div className="grid gap-2">
              <Label htmlFor="mcp-slug">
                {t("cloud.mcps.slugLabel", { defaultValue: "Slug" })}
              </Label>
              <Input
                id="mcp-slug"
                value={form.slug}
                placeholder="weather-tools"
                onChange={(e) => {
                  setSlugTouched(true);
                  update_("slug", slugify(e.target.value));
                }}
              />
              <p className="text-xs text-muted">
                {t("cloud.mcps.slugHint", {
                  defaultValue: "Lowercase letters, numbers and dashes only.",
                })}
              </p>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="mcp-description">
              {t("cloud.mcps.descriptionLabel", {
                defaultValue: "Description",
              })}
            </Label>
            <Textarea
              id="mcp-description"
              rows={2}
              value={form.description}
              onChange={(e) => update_("description", e.target.value)}
              placeholder={t("cloud.mcps.descriptionPlaceholder", {
                defaultValue: "What does this MCP server do?",
              })}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2 sm:gap-4">
            <div className="grid gap-2">
              <Label htmlFor="mcp-category">
                {t("cloud.mcps.categoryLabel", { defaultValue: "Category" })}
              </Label>
              <Select
                value={form.category}
                onValueChange={(v) => update_("category", v as McpCategory)}
              >
                <SelectTrigger id="mcp-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat} className="capitalize">
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mcp-pricing">
                {t("cloud.mcps.pricingLabel", { defaultValue: "Pricing" })}
              </Label>
              <Select
                value={form.pricingType}
                onValueChange={(v) =>
                  update_("pricingType", v as McpPricingType)
                }
              >
                <SelectTrigger id="mcp-pricing">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRICING_TYPES.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.pricingType === "credits" && (
            <div className="grid gap-2">
              <Label htmlFor="mcp-credits">
                {t("cloud.mcps.creditsLabel", {
                  defaultValue: "Credits per request",
                })}
              </Label>
              <Input
                id="mcp-credits"
                type="number"
                min={0}
                step="0.1"
                value={form.creditsPerRequest}
                onChange={(e) => update_("creditsPerRequest", e.target.value)}
              />
            </div>
          )}

          {form.pricingType === "x402" && (
            <div className="grid gap-2">
              <Label htmlFor="mcp-x402-price">
                {t("cloud.mcps.x402PriceLabel", {
                  defaultValue: "Price per request (USD)",
                })}
              </Label>
              <Input
                id="mcp-x402-price"
                type="number"
                min={0}
                step="0.0001"
                value={form.x402PriceUsd}
                onChange={(e) => update_("x402PriceUsd", e.target.value)}
              />
            </div>
          )}

          <div className="flex items-center justify-between rounded-sm border border-border bg-surface px-3 py-2">
            <Label htmlFor="mcp-x402-enabled" className="cursor-pointer">
              {t("cloud.mcps.x402EnabledLabel", {
                defaultValue: "Enable x402 micropayments",
              })}
            </Label>
            <Switch
              id="mcp-x402-enabled"
              checked={form.x402Enabled}
              onCheckedChange={(v) => update_("x402Enabled", v)}
            />
          </div>

          {!isEdit && (
            <div className="grid gap-2">
              <Label htmlFor="mcp-endpoint">
                {t("cloud.mcps.endpointLabel", {
                  defaultValue: "External endpoint URL",
                })}
              </Label>
              <Input
                id="mcp-endpoint"
                value={form.externalEndpoint}
                placeholder="https://example.com/mcp"
                onChange={(e) => update_("externalEndpoint", e.target.value)}
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="mcp-endpoint-path">
              {t("cloud.mcps.endpointPathLabel", {
                defaultValue: "Endpoint path",
              })}
            </Label>
            <Input
              id="mcp-endpoint-path"
              value={form.endpointPath}
              placeholder="/mcp"
              onChange={(e) => update_("endpointPath", e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="mcp-tools">
              {t("cloud.mcps.toolsLabel", {
                defaultValue: "Tools (one per line: name: description)",
              })}
            </Label>
            <Textarea
              id="mcp-tools"
              rows={4}
              value={form.toolsText}
              onChange={(e) => update_("toolsText", e.target.value)}
              placeholder={
                "get_weather: Get current weather\nget_forecast: Get a forecast"
              }
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted">
              {t("cloud.mcps.toolsHint", {
                defaultValue:
                  "At least one tool is required before you can publish.",
              })}
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="mcp-docs">
              {t("cloud.mcps.docsUrlLabel", {
                defaultValue: "Documentation URL (optional)",
              })}
            </Label>
            <Input
              id="mcp-docs"
              value={form.documentationUrl}
              placeholder="https://docs.example.com"
              onChange={(e) => update_("documentationUrl", e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <BrandButton
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cloud.mcps.cancel", { defaultValue: "Cancel" })}
          </BrandButton>
          <BrandButton
            variant="primary"
            onClick={() => void onSubmit()}
            disabled={submitting || !valid}
          >
            {submitting
              ? t("cloud.mcps.saving", { defaultValue: "Saving..." })
              : isEdit
                ? t("cloud.mcps.saveChanges", { defaultValue: "Save changes" })
                : t("cloud.mcps.register", { defaultValue: "Register MCP" })}
          </BrandButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Please try again.";
}
