import {
  Activity,
  AppWindow,
  Archive,
  Bot,
  Brain,
  Camera,
  ChevronDown,
  FileUp,
  Mic,
  MicOff,
  PanelRight,
  Pause,
  Radio,
  Search,
  Send,
  Sparkles,
  Square,
  Volume2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { ConceptMockup, GeneratedConceptImage } from "./ConceptMockup";
import {
  type AssistantConcept,
  assistantConcepts,
  assistantDirections,
  assistantLooks,
  researchFindings,
} from "./concept-data";

const PANEL =
  "rounded-sm border border-white/10 bg-white/[0.035] shadow-[0_24px_80px_rgba(0,0,0,0.34)]";
const MUTED_PANEL = "rounded-sm border border-white/10 bg-black/35";
const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1 text-xs text-white/70";
const BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-sm border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-medium text-white transition-colors hover:border-white/20 hover:bg-white/[0.1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF8A00]";
const ACTIVE_BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-sm border border-[#FF8A00]/50 bg-[#FF8A00] px-3 py-2 text-sm font-semibold text-black transition-colors hover:bg-[#FFB15A] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF8A00]";

type AssistantState = "listening" | "thinking" | "speaking" | "muted";

const stateConfig: Record<
  AssistantState,
  {
    label: string;
    icon: typeof Mic;
    caption: string;
    ring: string;
  }
> = {
  listening: {
    label: "Listening",
    icon: Radio,
    caption: "Live mic, interrupt-ready, transcript streaming",
    ring: "border-[#75D49A]/70 shadow-[0_0_50px_rgba(117,212,154,0.22)]",
  },
  thinking: {
    label: "Thinking",
    icon: Brain,
    caption: "Reasoning over chat, files, and current app context",
    ring: "border-[#FF8A00]/70 shadow-[0_0_50px_rgba(255,138,0,0.24)]",
  },
  speaking: {
    label: "Speaking",
    icon: Volume2,
    caption: "Audible response with visible text and barge-in control",
    ring: "border-white/45 shadow-[0_0_50px_rgba(255,255,255,0.18)]",
  },
  muted: {
    label: "Muted",
    icon: MicOff,
    caption: "Hardware-like privacy lock; voice cannot auto-resume",
    ring: "border-[#EF6A62]/80 shadow-[0_0_50px_rgba(239,106,98,0.2)]",
  },
};

function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; name: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-normal text-white/45">
        {label}
      </span>
      <select
        className="h-10 w-full appearance-none rounded-sm border border-white/10 bg-black/70 px-3 pr-9 text-sm text-white outline-none transition-colors hover:border-white/20 focus:border-[#FF8A00]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="all">All</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute bottom-2.5 right-3 h-4 w-4 text-white/45" />
    </label>
  );
}

function ResearchStrip() {
  return (
    <section className={`${PANEL} p-4`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-normal text-[#FF8A00]">
            Research spine
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-normal text-white">
            Patterns this matrix is built from
          </h2>
        </div>
        <span className={CHIP}>
          <Archive className="h-3.5 w-3.5" />5 source families
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-5">
        {researchFindings.map((finding) => (
          <a
            key={finding.source}
            href={finding.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-white/10 bg-black/35 p-3 transition-colors hover:border-white/25 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF8A00]"
          >
            <div className="text-sm font-semibold text-white">
              {finding.source}
            </div>
            <p className="mt-2 line-clamp-5 text-xs leading-5 text-white/58">
              {finding.finding}
            </p>
          </a>
        ))}
      </div>
    </section>
  );
}

function AvatarPreview({
  concept,
  assistantState,
}: {
  concept: AssistantConcept;
  assistantState: AssistantState;
}) {
  const config = stateConfig[assistantState];
  const StateIcon = config.icon;

  return (
    <div className={`${PANEL} overflow-hidden`}>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[#FF8A00]" />
          <span className="text-sm font-semibold text-white">
            Assistant window
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={CHIP}>
            <StateIcon className="h-3.5 w-3.5" />
            {config.label}
          </span>
          <span className={CHIP}>
            <AppWindow className="h-3.5 w-3.5" />
            Apps ready
          </span>
        </div>
      </div>

      <div className="grid min-h-[620px] gap-0 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative flex flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_18%,rgba(255,138,0,0.2),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(0,0,0,0.7))] p-5">
          <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4 py-4">
            <div className="grid content-start gap-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold tracking-normal text-white">
                    {concept.direction}
                  </h3>
                  <p className="mt-1 text-sm leading-5 text-white/62">
                    {config.caption}
                  </p>
                </div>
                <div
                  className={`grid h-14 w-14 shrink-0 place-items-center rounded-full border ${config.ring}`}
                >
                  <StateIcon className="h-6 w-6 text-[#FF8A00]" />
                </div>
              </div>
              <ConceptMockup concept={concept} />
            </div>
            <div className="grid content-start gap-3">
              <GeneratedConceptImage concept={concept} />
              <div className="grid grid-cols-2 gap-2">
                <span className={CHIP}>{concept.direction}</span>
                <span className={CHIP}>{concept.look}</span>
              </div>
            </div>
          </div>

          <div className={`${MUTED_PANEL} p-3`}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={CHIP}>
                <Camera className="h-3.5 w-3.5" />
                Screen paused
              </span>
              <span className={CHIP}>
                <FileUp className="h-3.5 w-3.5" />3 attachments
              </span>
              <span className={CHIP}>
                <Activity className="h-3.5 w-3.5" />
                Home app loading
              </span>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="min-h-12 flex-1 rounded-sm border border-white/10 bg-black/55 px-3 py-2 text-sm text-white/75">
                <span className="text-white/38">Live transcript: </span>I can
                see the active room, your uploaded floor plan, and the last
                thermostat change.
              </div>
              <button type="button" className={BUTTON} aria-label="Attach file">
                <FileUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={assistantState === "muted" ? ACTIVE_BUTTON : BUTTON}
                aria-label="Mute voice"
              >
                {assistantState === "muted" ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </button>
              <button type="button" className={ACTIVE_BUTTON}>
                {assistantState === "listening" ? (
                  <Square className="h-4 w-4" />
                ) : assistantState === "speaking" ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {assistantState === "listening"
                  ? "End"
                  : assistantState === "speaking"
                    ? "Interrupt"
                    : "Send"}
              </button>
            </div>
          </div>
        </div>

        <aside className="border-t border-white/10 bg-black/45 p-4 2xl:border-l 2xl:border-t-0">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Live context</h3>
            <PanelRight className="h-4 w-4 text-white/45" />
          </div>
          <div className="space-y-3">
            {[
              ["Voice", concept.voiceBehavior],
              ["Transcript", concept.transcriptBehavior],
              ["Controls", concept.controls],
              ["Attachments", concept.attachments],
              ["Apps", concept.appLoading],
              ["Suggestions", concept.suggestions],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-sm border border-white/10 p-3"
              >
                <div className="text-xs font-medium uppercase tracking-normal text-white/40">
                  {label}
                </div>
                <p className="mt-1 text-sm leading-5 text-white/70">{value}</p>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ConceptCard({
  concept,
  active,
  onSelect,
}: {
  concept: AssistantConcept;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`min-h-[156px] rounded-sm border p-4 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF8A00] ${
        active
          ? "border-[#FF8A00]/70 bg-[#FF8A00]/12"
          : "border-white/10 bg-white/[0.035] hover:border-white/25 hover:bg-white/[0.06]"
      }`}
    >
      <ConceptMockup concept={concept} size="thumb" />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">
            {concept.title}
          </div>
          <div className="mt-1 text-xs text-white/42">{concept.id}</div>
        </div>
        <Sparkles className="h-4 w-4 shrink-0 text-[#FF8A00]" />
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-5 text-white/62">
        {concept.pitch}
      </p>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <span className={CHIP}>{concept.direction}</span>
        <span className={CHIP}>{concept.look}</span>
      </div>
    </button>
  );
}

export default function AssistantConceptsPage() {
  const [directionId, setDirectionId] = useState("all");
  const [lookId, setLookId] = useState("all");
  const [query, setQuery] = useState("");
  const [assistantState, setAssistantState] =
    useState<AssistantState>("listening");
  const [selectedId, setSelectedId] = useState(assistantConcepts[0]?.id ?? "");

  const filteredConcepts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return assistantConcepts.filter((concept) => {
      if (directionId !== "all" && concept.directionId !== directionId) {
        return false;
      }
      if (lookId !== "all" && concept.lookId !== lookId) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [
        concept.title,
        concept.pitch,
        concept.voiceBehavior,
        concept.transcriptBehavior,
        concept.controls,
        concept.attachments,
        concept.appLoading,
        concept.suggestions,
        concept.bestFor,
        concept.risks,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [directionId, lookId, query]);

  const selectedConcept =
    assistantConcepts.find((concept) => concept.id === selectedId) ??
    filteredConcepts[0] ??
    assistantConcepts[0];

  return (
    <>
      <Helmet>
        <title>Assistant Concept Lab</title>
        <meta
          name="description"
          content="Browse 100 voice, chat, avatar, attachment, and app-loading assistant interface concepts."
        />
      </Helmet>
      <main className="min-h-screen bg-black text-white">
        <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-5 px-4 py-5 md:px-6 md:py-7">
          <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className={`${PANEL} p-5 md:p-6`}>
              <p className="text-sm font-medium uppercase tracking-normal text-[#FF8A00]">
                Assistant concept lab
              </p>
              <h1 className="mt-2 max-w-4xl text-3xl font-semibold tracking-normal text-white md:text-5xl">
                100 directions for avatar, chat, voice, attachments, and apps.
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-6 text-white/62 md:text-base">
                Twenty interaction directions crossed with five visual systems.
                Use this page to compare when text appears, how voice state is
                trusted, where attachments live, and how mini apps load without
                losing the conversation.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <span className={CHIP}>20 UX directions</span>
                <span className={CHIP}>5 visual looks</span>
                <span className={CHIP}>100 concepts</span>
                <span className={CHIP}>Voice state preview</span>
              </div>
            </div>
            <div className={`${PANEL} p-4`}>
              <h2 className="text-sm font-semibold text-white">
                Completion map
              </h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {[
                  ["Research inputs", researchFindings.length],
                  ["Directions", assistantDirections.length],
                  ["Looks", assistantLooks.length],
                  ["Concepts", assistantConcepts.length],
                ].map(([label, value]) => (
                  <div key={label} className={`${MUTED_PANEL} p-3`}>
                    <div className="text-2xl font-semibold text-white">
                      {value}
                    </div>
                    <div className="mt-1 text-xs text-white/45">{label}</div>
                  </div>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {Object.entries(stateConfig).map(([state, config]) => {
                  const Icon = config.icon;
                  return (
                    <button
                      key={state}
                      type="button"
                      onClick={() => setAssistantState(state as AssistantState)}
                      className={
                        assistantState === state ? ACTIVE_BUTTON : BUTTON
                      }
                    >
                      <Icon className="h-4 w-4" />
                      {config.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <ResearchStrip />

          <section className="grid gap-5 xl:grid-cols-[430px_minmax(0,1fr)]">
            <aside className={`${PANEL} h-fit p-4 xl:sticky xl:top-4`}>
              <div className="grid gap-3">
                <SelectControl
                  label="UX direction"
                  value={directionId}
                  options={assistantDirections}
                  onChange={setDirectionId}
                />
                <SelectControl
                  label="Visual look"
                  value={lookId}
                  options={assistantLooks}
                  onChange={setLookId}
                />
                <label>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-normal text-white/45">
                    Search behavior
                  </span>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/38" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="voice, mute, app, transcript..."
                      className="h-10 w-full rounded-sm border border-white/10 bg-black/70 pl-9 pr-3 text-sm text-white outline-none transition-colors placeholder:text-white/30 hover:border-white/20 focus:border-[#FF8A00]"
                    />
                  </div>
                </label>
              </div>

              <div className="mt-5 flex items-center justify-between text-sm">
                <span className="font-semibold text-white">
                  {filteredConcepts.length} concepts
                </span>
                <span className="text-white/45">
                  selected {selectedConcept.id}
                </span>
              </div>

              <div className="mt-3 grid max-h-[700px] gap-3 overflow-auto pr-1">
                {filteredConcepts.map((concept) => (
                  <ConceptCard
                    key={concept.id}
                    concept={concept}
                    active={concept.id === selectedConcept.id}
                    onSelect={() => setSelectedId(concept.id)}
                  />
                ))}
              </div>
            </aside>

            <div className="grid gap-5">
              <AvatarPreview
                concept={selectedConcept}
                assistantState={assistantState}
              />
              <section className={`${PANEL} grid gap-4 p-5 lg:grid-cols-3`}>
                <div>
                  <p className="text-xs font-medium uppercase tracking-normal text-white/42">
                    Best for
                  </p>
                  <p className="mt-2 text-sm leading-6 text-white/70">
                    {selectedConcept.bestFor}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-normal text-white/42">
                    Risk to resolve
                  </p>
                  <p className="mt-2 text-sm leading-6 text-white/70">
                    {selectedConcept.risks}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-normal text-white/42">
                    Core pitch
                  </p>
                  <p className="mt-2 text-sm leading-6 text-white/70">
                    {selectedConcept.pitch}
                  </p>
                </div>
              </section>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
