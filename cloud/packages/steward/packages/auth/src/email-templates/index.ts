import {
  type MagicLinkTemplateData,
  type RenderedMagicLinkTemplate,
  renderDefaultTemplate,
} from "./default";
import { renderElizaCloudTemplate } from "./elizacloud";

export type { MagicLinkTemplateData, RenderedMagicLinkTemplate } from "./default";

export function renderTemplate(
  templateId: string | undefined,
  data: MagicLinkTemplateData,
): RenderedMagicLinkTemplate {
  if (templateId === "elizacloud") {
    return renderElizaCloudTemplate(data);
  }

  return renderDefaultTemplate(data);
}
