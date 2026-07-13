/**
 * provider-icons — brand marks for each linked-account provider.
 *
 * Inline SVGs (simple-icons glyph paths, MIT) drawn in `currentColor` so
 * they inherit the row's text tone and adapt to light/dark automatically.
 * Functional icons (Plus, chevrons, status) stay on lucide-react; these are
 * strictly the provider *identity* marks so a row reads as "Anthropic",
 * "OpenAI", etc. at a glance instead of a text label.
 *
 * Sizing is caller-controlled via className (default 1em square). Every mark
 * is a single-path monochrome glyph — no baked-in brand colors — because the
 * settings surface uses one neutral treatment and can't ship a rainbow of
 * saturated logos into a calm list.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import type { ReactElement, SVGProps } from "react";

type BrandGlyphProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

function Glyph({
  path,
  title,
  viewBox = "0 0 24 24",
  className,
  ...rest
}: BrandGlyphProps & { path: string; viewBox?: string }) {
  return (
    <svg
      viewBox={viewBox}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={className}
      fill="currentColor"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={path} />
    </svg>
  );
}

// simple-icons: Anthropic (MIT)
export function AnthropicMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      path="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.541Zm-.3712 10.2232 2.2932-5.9456 2.2932 5.9456Z"
    />
  );
}

// simple-icons: OpenAI (MIT)
export function OpenAIMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      path="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
    />
  );
}

// simple-icons: Google Gemini (MIT)
export function GeminiMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      path="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68a12.3 12.3 0 0 1 2.55-3.84 12.3 12.3 0 0 1 3.84-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.84-2.55 12.3 12.3 0 0 1-2.55-3.84Q12 2.49 12 0q0 2.49-.96 4.68a12.3 12.3 0 0 1-2.52 3.84 12.3 12.3 0 0 1-3.84 2.55Q2.49 12 0 12q2.49 0 4.68.96a12.3 12.3 0 0 1 3.84 2.52 12.3 12.3 0 0 1 2.52 3.84"
    />
  );
}

// simple-icons: DeepSeek (MIT)
export function DeepSeekMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      path="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.5 17.938c-2.087-1.64-3.098-2.18-3.516-2.156-.392.022-.322.47-.235.762.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.239-.681l-.101-.06z"
    />
  );
}

// simple-icons: Moonshot AI / Kimi (MIT)
export function MoonshotMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      path="M1.052 16.916 15.11 13.13c1.187-.32 2.187-.55 3.16-.744-1.187-1.573-2.706-2.717-4.652-3.5L1.99 4.145A11.947 11.947 0 0 0 .17 9.63l-.026.207 6.28 2.523-5.63 1.517q.007.65.076 1.29.05.42.115.833zm.398 1.68a11.968 11.968 0 0 0 20.86 1.7L9.618 15.185zM11.998.03C6.859.03 2.407 3.26.664 7.797l11.85 4.762c1.44-.362 3.017-.55 5.09-.756l4.68-.466A11.968 11.968 0 0 0 11.998.03z"
    />
  );
}

// simple-icons: Z (z.ai / Zhipu) — using a clean Z monogram in currentColor
export function ZaiMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      viewBox="0 0 24 24"
      path="M4.5 4.5h15v2.9L9.1 18.6h10.4v2.9h-15v-2.9L14.9 7.4H4.5z"
    />
  );
}

// Cerebras — stylized concentric brain-loop monogram (original, no brand color)
export function CerebrasMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      viewBox="0 0 24 24"
      path="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2.4a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2zm0 2.9a4.7 4.7 0 1 0 0 9.4 4.7 4.7 0 0 0 0-9.4zm0 2.3a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z"
    />
  );
}

// Eliza Cloud — the eliza spark mark (simplified, currentColor)
export function ElizaCloudMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      viewBox="0 0 24 24"
      path="M6.5 6.5A5.5 5.5 0 0 1 12 1a5.5 5.5 0 0 1 5.5 5.5c1.93.24 3.5 1.9 3.5 3.98A4.02 4.02 0 0 1 16.98 14.5H7.02A4.02 4.02 0 0 1 3 10.48c0-2.08 1.57-3.74 3.5-3.98zM7 17.4h10v2.1H7zm2.6 3.4h4.8V23H9.6z"
    />
  );
}

// Local / on-device — a monitor+chip glyph
export function LocalMark(props: BrandGlyphProps) {
  return (
    <Glyph
      {...props}
      viewBox="0 0 24 24"
      path="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm5 5v4h6V8H9z"
    />
  );
}

const PROVIDER_MARKS: Record<
  LinkedAccountProviderId,
  (props: BrandGlyphProps) => ReactElement
> = {
  "anthropic-api": AnthropicMark,
  "anthropic-subscription": AnthropicMark,
  "openai-api": OpenAIMark,
  "openai-codex": OpenAIMark,
  "gemini-cli": GeminiMark,
  "deepseek-api": DeepSeekMark,
  "deepseek-coding": DeepSeekMark,
  "moonshot-api": MoonshotMark,
  "kimi-coding": MoonshotMark,
  "zai-api": ZaiMark,
  "zai-coding": ZaiMark,
  "cerebras-api": CerebrasMark,
};

export interface ProviderMarkProps extends BrandGlyphProps {
  providerId: LinkedAccountProviderId;
}

/** Resolve and render the brand mark for a linked-account provider id. */
export function ProviderMark({ providerId, ...rest }: ProviderMarkProps) {
  const Mark = PROVIDER_MARKS[providerId] ?? AnthropicMark;
  return <Mark {...rest} />;
}

export function hasProviderMark(providerId: LinkedAccountProviderId): boolean {
  return providerId in PROVIDER_MARKS;
}
