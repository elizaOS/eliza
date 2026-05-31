import {
  AppWindow,
  Camera,
  FileText,
  FileUp,
  Lock,
  Mic,
  Monitor,
  Radio,
  Sparkles,
  Volume2,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AssistantConcept } from "./concept-data";
import { getConceptVisual } from "./visual-model";

type ConceptMockupProps = {
  concept: AssistantConcept;
  size?: "thumb" | "detail";
};

function Bars({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-1">
      {Array.from({ length: count }).map((_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: decorative fixed bars
          key={index}
          className="h-1 rounded-full bg-current opacity-20"
          style={{ width: `${92 - index * 13}%` }}
        />
      ))}
    </div>
  );
}

function SourceIcon({ source }: { source: string }) {
  if (source === "camera") return <Camera className="h-3 w-3" />;
  if (source === "screen") return <Monitor className="h-3 w-3" />;
  if (source === "file") return <FileUp className="h-3 w-3" />;
  if (source === "app") return <AppWindow className="h-3 w-3" />;
  if (source === "text") return <FileText className="h-3 w-3" />;
  return <Mic className="h-3 w-3" />;
}

function AvatarGlyph({
  shape,
  className,
}: {
  shape: string;
  className: string;
}) {
  if (shape === "capsule") {
    return (
      <div className={`h-12 w-24 rounded-full border ${className}`}>
        <div className="mx-auto mt-4 h-3 w-12 rounded-full bg-[#FF8A00]" />
      </div>
    );
  }
  if (shape === "device") {
    return (
      <div
        className={`grid h-20 w-14 place-items-center rounded-sm border ${className}`}
      >
        <Radio className="h-6 w-6 text-[#FF8A00]" />
      </div>
    );
  }
  if (shape === "portrait") {
    return (
      <div
        className={`grid h-16 w-16 place-items-center rounded-full border ${className}`}
      >
        <div className="h-8 w-8 rounded-full bg-[#FF8A00]" />
      </div>
    );
  }
  if (shape === "scope") {
    return (
      <div
        className={`relative grid h-20 w-20 place-items-center rounded-full border ${className}`}
      >
        <div className="absolute h-px w-16 bg-current opacity-20" />
        <div className="absolute h-16 w-px bg-current opacity-20" />
        <div className="h-7 w-7 rounded-full bg-[#FF8A00]" />
      </div>
    );
  }
  return (
    <div
      className={`grid h-20 w-20 place-items-center rounded-full border ${className}`}
    >
      <Volume2 className="h-7 w-7 text-[#FF8A00]" />
    </div>
  );
}

function MiniPanel({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children?: ReactNode;
}) {
  return (
    <div className={`rounded-sm border p-2 ${className}`}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-normal opacity-50">
        {label}
      </div>
      {children ?? <Bars />}
    </div>
  );
}

function DirectionLayout({
  concept,
  compact,
}: {
  concept: AssistantConcept;
  compact: boolean;
}) {
  const visual = getConceptVisual(concept);
  const panel = visual.panelClass;
  const quiet = visual.quietPanelClass;
  const chip = `inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] ${quiet}`;

  if (visual.primarySurface === "console") {
    return (
      <div className="grid h-full grid-cols-[0.7fr_1.2fr_0.8fr] gap-2">
        <div className="grid gap-2">
          <MiniPanel label="Commands" className={panel} />
          <MiniPanel label={visual.controlModel} className={quiet} />
          <MiniPanel label="Sources" className={quiet}>
            <div className="flex flex-wrap gap-1">
              {visual.sourceMix.slice(0, 4).map((source) => (
                <span key={source} className={chip}>
                  <SourceIcon source={source} />
                </span>
              ))}
            </div>
          </MiniPanel>
        </div>
        <MiniPanel label={visual.heroLabel} className={panel}>
          <div className="grid gap-2">
            <div className="h-10 rounded-sm border border-current/15 bg-current/5" />
            <Bars count={compact ? 3 : 5} />
            <div className="grid grid-cols-3 gap-1">
              {visual.suggestionLabels.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-[#FF8A00] px-1.5 py-1 text-center text-[9px] text-black"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </MiniPanel>
        <div className="grid gap-2">
          <MiniPanel label={visual.appLabel} className={panel} />
          <MiniPanel label={visual.transcriptLabel} className={quiet} />
        </div>
      </div>
    );
  }

  if (visual.primarySurface === "canvas") {
    return (
      <div className="grid h-full grid-cols-[1.2fr_0.8fr] gap-2">
        <MiniPanel label={visual.heroLabel} className={panel}>
          <div className="grid h-full grid-cols-2 gap-2">
            <div className="rounded-sm border border-current/15 bg-current/5 p-2">
              <AvatarGlyph
                shape={visual.avatarShape}
                className={visual.avatarClass}
              />
            </div>
            <div className="grid content-between gap-2">
              <Bars count={4} />
              <div className="flex flex-wrap gap-1">
                {visual.sourceMix.slice(0, 5).map((source) => (
                  <span key={source} className={chip}>
                    <SourceIcon source={source} />
                    {source}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </MiniPanel>
        <div className="grid gap-2">
          <MiniPanel label={visual.appLabel} className={panel} />
          <MiniPanel label={visual.transcriptLabel} className={quiet} />
          {!compact ? (
            <MiniPanel label="Suggestions" className={quiet} />
          ) : null}
        </div>
      </div>
    );
  }

  if (
    visual.primarySurface === "timeline" ||
    visual.primarySurface === "pipeline"
  ) {
    const steps =
      visual.primarySurface === "pipeline"
        ? ["Intent", "Run", "Review", "Done"]
        : ["Now", "Next", "Later", "Recap"];
    return (
      <div className="grid h-full gap-2">
        <div className="grid grid-cols-4 gap-2">
          {steps.map((step, index) => (
            <div
              key={step}
              className={`rounded-sm border p-2 ${index === 1 ? panel : quiet}`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold">{step}</span>
                <span className="h-2 w-2 rounded-full bg-[#FF8A00]" />
              </div>
              <Bars count={2} />
            </div>
          ))}
        </div>
        <div className="grid flex-1 grid-cols-[0.8fr_1.2fr_0.8fr] gap-2">
          <MiniPanel label={visual.transcriptLabel} className={quiet} />
          <MiniPanel label={visual.heroLabel} className={panel}>
            <div className="flex h-full items-center justify-center">
              <AvatarGlyph
                shape={visual.avatarShape}
                className={visual.avatarClass}
              />
            </div>
          </MiniPanel>
          <MiniPanel label={visual.appLabel} className={quiet} />
        </div>
      </div>
    );
  }

  if (visual.primarySurface === "inbox") {
    return (
      <div className="grid h-full grid-cols-[0.9fr_1.1fr] gap-2">
        <div className="grid gap-2">
          {["Urgent", "Waiting", "Draft"].map((label, index) => (
            <MiniPanel
              key={label}
              label={label}
              className={index === 0 ? panel : quiet}
            />
          ))}
        </div>
        <MiniPanel label={visual.heroLabel} className={panel}>
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <AvatarGlyph
                shape={visual.avatarShape}
                className={visual.avatarClass}
              />
              <Bars count={4} />
            </div>
            <MiniPanel label={visual.appLabel} className={quiet} />
          </div>
        </MiniPanel>
      </div>
    );
  }

  if (visual.primarySurface === "stage") {
    return (
      <div className="relative grid h-full place-items-center overflow-hidden">
        <div className="absolute left-3 top-3 flex flex-wrap gap-1">
          {visual.sourceMix.slice(0, 4).map((source) => (
            <span key={source} className={chip}>
              <SourceIcon source={source} />
              {!compact ? source : null}
            </span>
          ))}
        </div>
        <div className="absolute right-3 top-3 rounded-sm border border-current/15 bg-current/5 px-2 py-1 text-[10px]">
          {visual.appLabel}
        </div>
        <div className="grid justify-items-center gap-3">
          <AvatarGlyph
            shape={visual.avatarShape}
            className={visual.avatarClass}
          />
          <div className="text-center text-xs font-semibold">
            {visual.heroLabel}
          </div>
          <div className="flex flex-wrap justify-center gap-1">
            {visual.suggestionLabels.map((label) => (
              <span key={label} className={chip}>
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="absolute bottom-3 left-3 right-3 rounded-sm border border-current/15 bg-current/5 p-2 text-[10px]">
          {visual.transcriptLabel}
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[1fr_0.8fr] gap-2">
      <MiniPanel label={visual.heroLabel} className={panel}>
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <AvatarGlyph
              shape={visual.avatarShape}
              className={visual.avatarClass}
            />
            <Bars count={4} />
          </div>
          <MiniPanel label={visual.transcriptLabel} className={quiet} />
          <div className="flex flex-wrap gap-1">
            {visual.suggestionLabels.map((label) => (
              <span key={label} className={chip}>
                {label}
              </span>
            ))}
          </div>
        </div>
      </MiniPanel>
      <div className="grid gap-2">
        <MiniPanel label={visual.appLabel} className={panel} />
        <MiniPanel label="Attachments" className={quiet}>
          <div className="flex gap-1">
            <FileUp className="h-4 w-4" />
            <Lock className="h-4 w-4" />
            <Sparkles className="h-4 w-4 text-[#FF8A00]" />
          </div>
        </MiniPanel>
      </div>
    </div>
  );
}

export function ConceptMockup({
  concept,
  size = "detail",
}: ConceptMockupProps) {
  const visual = getConceptVisual(concept);
  const compact = size === "thumb";

  return (
    <div
      className={`relative overflow-hidden rounded-sm border ${visual.frameClass} ${
        compact ? "aspect-[16/10] p-2" : "min-h-[360px] p-4"
      }`}
      role="img"
      aria-label={`${concept.title} HTML visual mockup`}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          background: `radial-gradient(circle at 24% 18%, ${visual.imageAccent}55, transparent 32%), radial-gradient(circle at 82% 72%, ${visual.imageSecondary}26, transparent 28%)`,
        }}
      />
      <div className="relative z-10 flex h-full flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#FF8A00]" />
            <span className="truncate text-[11px] font-semibold uppercase tracking-normal">
              {visual.heroLabel}
            </span>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-current/15 px-2 py-1 text-[10px]">
            <Radio className="h-3 w-3" />
            Voice
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <DirectionLayout concept={concept} compact={compact} />
        </div>
      </div>
    </div>
  );
}

export function GeneratedConceptImage({
  concept,
}: {
  concept: AssistantConcept;
}) {
  const visual = getConceptVisual(concept);
  return (
    <figure className="overflow-hidden rounded-sm border border-white/10 bg-black/35">
      <img
        src={visual.imageUrl}
        alt={`${concept.title} generated assistant preview`}
        className="aspect-[16/10] w-full object-cover"
      />
      <figcaption className="border-t border-white/10 p-3 text-xs leading-5 text-white/55">
        Generated image prompt: {visual.imagePrompt}
      </figcaption>
    </figure>
  );
}
