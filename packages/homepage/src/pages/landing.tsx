/**
 * eliza.app landing page: a single-viewport, social-agent lander.
 *
 * The first action opens a native message handler where supported and copies
 * the number elsewhere; account and app setup stay out of the way until someone
 * wants the richer companion experience. The phone demo shows Eliza inside a
 * group conversation. Advanced examples name the connected source, room scope,
 * or permission behind them instead of implying silent external access. It is
 * decorative and intentionally English-only. Reduced motion shows its settled
 * friends room while keeping the five-room contract in the DOM.
 */

import {
  DiscordIcon,
  IMessageIcon,
  TelegramIcon,
} from "@elizaos/ui/cloud-ui/components/icons";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  buildElizaDiscordHref,
  buildElizaTelegramHref,
  ELIZA_PHONE_NUMBER,
  openOrCopyElizaMessage,
} from "@/lib/contact";
import {
  LANDING_DEMO_MEMBER_AVATARS,
  LANDING_DEMO_SCENARIOS,
  type LandingDemoCard,
  type LandingDemoScenario,
  type LandingDemoScenarioId,
  type LandingDemoStep,
} from "@/lib/landing-demo";
import { resolveHomepageProductNavigation } from "@/lib/product-navigation";
import { useT } from "@/providers/I18nProvider";

// The ambient gradient wave stays lazy so the static hero is interactive
// before any WebGL code downloads.
const ShaderBackground = lazy(
  () => import("@/components/ShaderBackground/ShaderBackground"),
);

function DeferredShaderBackground(): React.JSX.Element | null {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setReady(true));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== 0) window.cancelAnimationFrame(secondFrame);
    };
  }, []);

  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <ShaderBackground />
    </Suspense>
  );
}

type DemoCard = LandingDemoCard;
type DemoStep = LandingDemoStep;

type DemoItem =
  | {
      from: "eliza" | "member" | "user";
      id: number;
      kind: "text";
      name?: string;
      text: string;
    }
  | { from: "eliza"; id: number; kind: "card"; card: DemoCard };

interface DemoSender {
  avatar: string;
  name: string;
}

const DEMO_SENDERS: Record<string, DemoSender> = {
  Eliza: {
    avatar: "/brand/logos/logo_white_orangebg.svg",
    name: "Eliza",
  },
  ...Object.fromEntries(
    Object.entries(LANDING_DEMO_MEMBER_AVATARS).map(([name, avatar]) => [
      name,
      { avatar, name },
    ]),
  ),
};

const DEMO_SCENARIOS: readonly LandingDemoScenario[] = LANDING_DEMO_SCENARIOS;
const INITIAL_RENDERED_ITEMS = 4;
const USER_KEYSTROKE_MS = 28;
const HUMAN_REPLY_BASE_MS = 650;
const HUMAN_REPLY_PER_CHARACTER_MS = 14;
const HUMAN_REPLY_MAX_MS = 1_250;
const ELIZA_TYPING_MS = 360;
const BEAT_PAUSE_MS = 180;
const PRE_USER_MS = 500;
const PRE_ELIZA_MS = 120;
const PRE_CARD_MS = 240;
const SEND_HOLD_MS = 240;
const SCENARIO_READING_HOLD_MS = 5_500;
const SCENARIO_SWITCH_MS = 320;

function humanReplyDelay(text: string): number {
  return Math.min(
    HUMAN_REPLY_MAX_MS,
    HUMAN_REPLY_BASE_MS + text.length * HUMAN_REPLY_PER_CHARACTER_MS,
  );
}

const LOCAL_CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function localClock(date: Date, includeDayPeriod: boolean): string {
  const parts = LOCAL_CLOCK_FORMATTER.formatToParts(date);
  return parts
    .filter((part) => includeDayPeriod || part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
}

function scenarioItems(
  scenario: LandingDemoScenario,
  scenarioIndex: number,
): DemoItem[] {
  return scenario.steps.map((step, index) =>
    step.kind === "card"
      ? {
          id: scenarioIndex * 100 + index,
          from: "eliza",
          kind: "card",
          card: step.card,
        }
      : {
          id: scenarioIndex * 100 + index,
          from: step.kind,
          kind: "text",
          name: step.kind === "member" ? step.name : undefined,
          text: step.text,
        },
  );
}

function senderForItem(item: DemoItem | undefined): DemoSender | null {
  if (!item || item.from === "user") return null;
  if (item.from === "eliza") {
    return DEMO_SENDERS.Eliza;
  }
  return item.name ? (DEMO_SENDERS[item.name] ?? null) : null;
}

function sameSender(a: DemoItem | undefined, b: DemoItem | undefined): boolean {
  const first = senderForItem(a);
  const second = senderForItem(b);
  return first !== null && second !== null && first.name === second.name;
}

function DemoProfilePhoto({ sender }: { sender: DemoSender }) {
  return (
    <img
      className={`landing-message-avatar landing-message-avatar--${sender.name.toLowerCase()}`}
      src={sender.avatar}
      alt=""
      width={192}
      height={192}
    />
  );
}

function DemoSourceIcon({
  kind,
}: {
  kind: NonNullable<DemoCard["source"]>["kind"];
}) {
  if (kind === "calendar") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.2" y="3.4" width="11.6" height="10.2" rx="2" />
        <path d="M5 2v3M11 2v3M2.5 6.5h11" />
      </svg>
    );
  }
  if (kind === "web") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.8" />
        <path d="M2.5 8h11M8 2.2c1.7 1.6 2.6 3.5 2.6 5.8S9.7 12.2 8 13.8C6.3 12.2 5.4 10.3 5.4 8S6.3 3.8 8 2.2Z" />
      </svg>
    );
  }
  if (kind === "memory") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <ellipse cx="8" cy="4" rx="5.3" ry="2.2" />
        <path d="M2.7 4v4c0 1.2 2.4 2.2 5.3 2.2s5.3-1 5.3-2.2V4M2.7 8v4c0 1.2 2.4 2.2 5.3 2.2s5.3-1 5.3-2.2V8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.1 6.5A2.9 2.9 0 0 1 8 3.4a2.9 2.9 0 0 1 2.9 3.1c0 3.1 1.7 3.5 1.7 4.5H3.4c0-1 1.7-1.4 1.7-4.5Z" />
      <path d="M6.5 13a1.7 1.7 0 0 0 3 0" />
    </svg>
  );
}

function DemoCardBubble({ card }: { card: DemoCard }) {
  return (
    <div className="landing-demo-card" data-capability={card.capability}>
      <span className="landing-demo-card-label">{card.label}</span>
      <strong>{card.title}</strong>
      {card.rows.map((row) => (
        <span className="landing-demo-card-row" key={row}>
          {row}
        </span>
      ))}
      {card.source ? (
        <span
          className="landing-demo-card-source"
          data-demo-source={card.source.kind}
        >
          <DemoSourceIcon kind={card.source.kind} />
          {card.source.label}
        </span>
      ) : null}
      {card.status ? (
        <span
          className="landing-demo-card-status"
          data-status-kind={card.statusKind ?? "confirmed"}
        >
          {card.statusKind === "open" ? (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="5.3" />
              <path d="M8 5v3.2l2.1 1.25" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m3 8.3 3 3L13 4.7" />
            </svg>
          )}
          {card.status}
        </span>
      ) : null}
    </div>
  );
}

function PhoneMockup() {
  const t = useT();
  const [clock, setClock] = useState(() => new Date());
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [items, setItems] = useState<DemoItem[]>(() =>
    scenarioItems(DEMO_SCENARIOS[0], 0).slice(0, INITIAL_RENDERED_ITEMS),
  );
  const [phase, setPhase] = useState<"playing" | "settled" | "switching">(
    "playing",
  );
  const [visitedScenarioIds, setVisitedScenarioIds] = useState<
    LandingDemoScenarioId[]
  >([DEMO_SCENARIOS[0].id]);
  const [cycle, setCycle] = useState(0);
  const [typingSenders, setTypingSenders] = useState<DemoSender[]>([]);
  const [composerText, setComposerText] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const scenario = DEMO_SCENARIOS[scenarioIndex];

  useEffect(() => {
    const interval = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setItems(scenarioItems(DEMO_SCENARIOS[0], 0));
      setVisitedScenarioIds(DEMO_SCENARIOS.map(({ id }) => id));
      setPhase("settled");
      return;
    }

    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const play = async (
      steps: readonly DemoStep[],
      activeScenarioIndex: number,
    ) => {
      for (const [index, step] of steps.entries()) {
        if (cancelled) return;
        const id = activeScenarioIndex * 100 + INITIAL_RENDERED_ITEMS + index;
        const nextStep = steps[index + 1];
        if (step.kind === "user") {
          await sleep(PRE_USER_MS);
          for (let i = 1; i <= step.text.length; i++) {
            if (cancelled) return;
            setComposerText(step.text.slice(0, i));
            await sleep(USER_KEYSTROKE_MS);
          }
          await sleep(SEND_HOLD_MS);
          if (cancelled) return;
          setComposerText("");
          setItems((previous) => [
            ...previous,
            { id, from: "user", kind: "text", text: step.text },
          ]);
        } else if (step.kind === "member") {
          const humanTypers: DemoSender[] = [];
          const currentSender = DEMO_SENDERS[step.name];
          const nextSender =
            nextStep?.kind === "member"
              ? DEMO_SENDERS[nextStep.name]
              : undefined;
          if (currentSender) humanTypers.push(currentSender);
          if (nextSender && nextSender.name !== currentSender?.name) {
            humanTypers.push(nextSender);
          }
          setTypingSenders(humanTypers);
          await sleep(humanReplyDelay(step.text));
          if (cancelled) return;
          setTypingSenders(nextSender ? [nextSender] : []);
          setItems((previous) => [
            ...previous,
            {
              id,
              from: "member",
              kind: "text",
              name: step.name,
              text: step.text,
            },
          ]);
        } else if (step.kind === "eliza") {
          await sleep(step.continuation ? 360 : PRE_ELIZA_MS);
          if (cancelled) return;
          if (!step.continuation) {
            setTypingSenders([DEMO_SENDERS.Eliza]);
            await sleep(ELIZA_TYPING_MS);
            if (cancelled) return;
            setTypingSenders([]);
          }
          setItems((previous) => [
            ...previous,
            { id, from: "eliza", kind: "text", text: step.text },
          ]);
        } else {
          await sleep(PRE_CARD_MS);
          if (cancelled) return;
          setItems((previous) => [
            ...previous,
            { id, from: "eliza", kind: "card", card: step.card },
          ]);
        }
        await sleep(
          nextStep?.kind === "eliza" && nextStep.continuation
            ? 280
            : BEAT_PAUSE_MS,
        );
      }
    };

    (async () => {
      let completedCycles = 0;
      while (!cancelled) {
        for (const [index, nextScenario] of DEMO_SCENARIOS.entries()) {
          const firstRoom = completedCycles === 0 && index === 0;
          if (!firstRoom) {
            setPhase("switching");
            setTypingSenders([]);
            setComposerText("");
            await sleep(SCENARIO_SWITCH_MS);
            if (cancelled) return;
            setScenarioIndex(index);
            setItems(
              scenarioItems(nextScenario, index).slice(
                0,
                INITIAL_RENDERED_ITEMS,
              ),
            );
            setVisitedScenarioIds((previous) =>
              previous.includes(nextScenario.id)
                ? previous
                : [...previous, nextScenario.id],
            );
            setPhase("playing");
          }
          await play(nextScenario.steps.slice(INITIAL_RENDERED_ITEMS), index);
          if (cancelled) return;
          setPhase("settled");
          await sleep(SCENARIO_READING_HOLD_MS);
          if (cancelled) return;
        }
        completedCycles += 1;
        setCycle(completedCycles);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the thread pinned to the newest message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll reacts to content growth, not to values read inside.
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
    // composerText opens/closes the keyboard, which changes the thread's
    // height; re-pin so the newest message stays visible.
  }, [items, typingSenders, composerText]);

  const typingSenderKind =
    typingSenders.length === 1 &&
    typingSenders[0]?.name === DEMO_SENDERS.Eliza.name
      ? "eliza"
      : "member";
  const typingSenderNames = typingSenders.map(({ name }) => name).join(" and ");
  const typingAccessibilityLabel = `${typingSenderNames} ${typingSenders.length === 1 ? "is" : "are"} typing`;

  return (
    <div
      className="landing-iphone"
      data-demo-phase={phase}
      data-demo-messages={items.length}
      data-demo-scenario={scenario.id}
      data-demo-scenario-index={scenarioIndex + 1}
      data-demo-scenarios={DEMO_SCENARIOS.length}
      data-demo-visited={visitedScenarioIds.join(",")}
      data-demo-cycle={cycle}
      data-demo-typing={typingSenders.map(({ name }) => name).join(",")}
    >
      <div className="landing-iphone-screen">
        <div className="landing-phone-top">
          <div className="landing-iphone-statusbar">
            <span className="landing-iphone-time">
              {localClock(clock, false)}
            </span>
            <span className="landing-iphone-island" />
            <span className="landing-iphone-signal">
              <svg viewBox="0 0 41 12" fill="currentColor" aria-hidden="true">
                <rect x="0" y="7" width="3" height="5" rx="1" />
                <rect x="5" y="5" width="3" height="7" rx="1" />
                <rect x="10" y="3" width="3" height="9" rx="1" />
                <rect x="15" y="1" width="3" height="11" rx="1" />
                <rect
                  x="24"
                  y="1"
                  width="14"
                  height="10"
                  rx="2.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect x="25.7" y="2.7" width="10" height="6.6" rx="1.2" />
                <path
                  d="M39.2 4.1v3.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </div>
          <div className="landing-phone-header landing-phone-header--group">
            <span className="sr-only">
              {`Illustrative ${scenario.label.toLowerCase()} group conversation in ${scenario.roomName} with ${scenario.members.join(", ")}, and Eliza`}
            </span>
            <span className="landing-phone-back" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m15 19-7-7 7-7" />
              </svg>
            </span>
            <span className="landing-phone-contact landing-phone-contact--group">
              <span className="landing-group-avatars" aria-hidden="true">
                {scenario.members.slice(0, 3).map((member) => (
                  <img
                    key={member}
                    className="landing-group-avatar"
                    src={DEMO_SENDERS[member].avatar}
                    alt=""
                  />
                ))}
                <img
                  className="landing-group-avatar"
                  src={DEMO_SENDERS.Eliza.avatar}
                  alt=""
                  width={423}
                  height={423}
                />
              </span>
              <span className="landing-phone-name landing-phone-name--group">
                <span>
                  <strong>{scenario.roomName}</strong>
                  <small>
                    {scenario.participantLabel ??
                      `${scenario.members.length + 2} people`}
                  </small>
                </span>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </span>
            </span>
            <span className="landing-phone-video" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="6" width="12" height="12" rx="3" />
                <path d="m15 10 5-3v10l-5-3" />
              </svg>
            </span>
          </div>
        </div>
        <div
          className="landing-phone-thread scroll-fade scroll-fade-[1.6rem] [--scroll-fade-reveal:96px]"
          ref={threadRef}
        >
          <div className="landing-thread-preamble">
            <span className="landing-thread-timestamp">
              Today {localClock(clock, true)}
            </span>
          </div>
          {items.map((item, index) => {
            const sender = senderForItem(item);
            const showAuthor =
              sender !== null && !sameSender(items[index - 1], item);
            const showAvatar =
              sender !== null && !sameSender(item, items[index + 1]);
            return (
              <div
                key={item.id}
                data-demo-item="true"
                className={`landing-message landing-message--${item.from}${item.kind === "card" ? " landing-message--card" : ""}`}
              >
                {sender ? (
                  <span className="landing-message-avatar-slot">
                    {showAvatar ? <DemoProfilePhoto sender={sender} /> : null}
                  </span>
                ) : null}
                <div className="landing-message-body">
                  {showAuthor ? (
                    <span className="landing-message-author">
                      {sender.name}
                    </span>
                  ) : null}
                  {item.kind === "card" ? (
                    <div className="landing-bubble-card">
                      <DemoCardBubble card={item.card} />
                    </div>
                  ) : (
                    <p
                      className={`landing-bubble landing-bubble--${item.from}`}
                    >
                      {item.text}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
          {typingSenders.length > 0 ? (
            <div
              className={`landing-message landing-message--${typingSenderKind} landing-message--typing${typingSenders.length > 1 ? " landing-message--typing-multiple" : ""}`}
              data-demo-typing-indicator={typingSenderNames}
            >
              <span className="landing-message-avatar-slot">
                {typingSenders.map((sender) => (
                  <DemoProfilePhoto key={sender.name} sender={sender} />
                ))}
              </span>
              <div className="landing-message-body">
                <span className="landing-message-author">
                  {typingSenderNames}
                </span>
                <div
                  className={`landing-bubble landing-bubble--${typingSenderKind} landing-typing`}
                  aria-label={typingAccessibilityLabel}
                  role="status"
                >
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="landing-composer-row">
          <span className="landing-composer-plus">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <div
            className="landing-phone-composer"
            data-typing={composerText !== ""}
          >
            <span className="landing-composer-text">
              <span className="landing-composer-typed">
                {composerText === "" ? (
                  t("homepage_eliza.landing.demoComposer", {
                    defaultValue: "iMessage",
                  })
                ) : (
                  <>
                    {composerText}
                    <span className="landing-composer-caret" />
                  </>
                )}
              </span>
            </span>
            {composerText === "" ? (
              <svg
                className="landing-composer-mic"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 11v1a7 7 0 0 1-14 0v-1M12 19v3" />
              </svg>
            ) : (
              <span className="landing-composer-send">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </span>
            )}
          </div>
        </div>
        <DemoKeyboard composerText={composerText} />
        <div className="landing-iphone-homebar" aria-hidden="true" />
      </div>
    </div>
  );
}

function ResponsivePhoneMockup() {
  const stageRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const frame = stage?.querySelector<HTMLElement>(".landing-iphone");
    if (!stage || !frame) return;

    const fitFrame = () => {
      const widthScale = stage.clientWidth / frame.offsetWidth;
      const heightScale = stage.clientHeight / frame.offsetHeight;
      const scale = Math.max(0.1, Math.min(1, widthScale, heightScale));
      stage.style.setProperty("--landing-phone-scale", String(scale));
    };

    fitFrame();
    const observer = new ResizeObserver(fitFrame);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing-phone-stage" ref={stageRef}>
      <PhoneMockup />
    </div>
  );
}

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"] as const;

/**
 * iOS-style keyboard that slides up while the demo user is typing. The key
 * matching the most recent character lights briefly, and the prediction bar
 * echoes the word in progress the way iOS QuickType does.
 */
function DemoKeyboard({ composerText }: { composerText: string }) {
  const open = composerText !== "";
  const lastChar = composerText.slice(-1).toLowerCase();
  const lastWord = composerText.split(/\s+/).pop() ?? "";
  return (
    <div className="landing-keyboard" data-open={open} aria-hidden="true">
      <div className="landing-keyboard-clip">
        <div className="landing-keyboard-inner">
          <div className="landing-kb-suggestions">
            <span>{lastWord ? `“${lastWord}”` : ""}</span>
            <span>{lastWord}</span>
            <span>{lastWord ? `${lastWord}s` : ""}</span>
          </div>
          {KEYBOARD_ROWS.map((row, rowIndex) => (
            <div key={row} className="landing-kb-row">
              {rowIndex === 2 ? (
                <span className="landing-kb-key landing-kb-key--special">
                  ⇧
                </span>
              ) : null}
              {row.split("").map((key) => (
                <span
                  key={key}
                  className="landing-kb-key"
                  data-active={key === lastChar}
                >
                  {key}
                </span>
              ))}
              {rowIndex === 2 ? (
                <span className="landing-kb-key landing-kb-key--special">
                  ⌫
                </span>
              ) : null}
            </div>
          ))}
          <div className="landing-kb-row">
            <span className="landing-kb-key landing-kb-key--special">123</span>
            <span
              className="landing-kb-key landing-kb-key--space"
              data-active={lastChar === " "}
            />
            <span className="landing-kb-key landing-kb-key--return">
              return
            </span>
          </div>
          <div className="landing-kb-bottom">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
            </svg>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 11v1a7 7 0 0 1-14 0v-1M12 19v3" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContactSheet({
  open,
  onClose,
  onText,
  accountHref,
  accountLabel,
}: {
  open: boolean;
  onClose: () => void;
  onText: () => void;
  accountHref: string;
  accountLabel: string;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const dismissOnBackdrop = (event: MouseEvent) => {
      if (event.target === dialog) onClose();
    };
    dialog.addEventListener("click", dismissOnBackdrop);
    return () => dialog.removeEventListener("click", dismissOnBackdrop);
  }, [onClose]);

  return (
    <dialog ref={dialogRef} className="landing-sheet" onClose={onClose}>
      <div className="landing-sheet-body">
        <header className="landing-sheet-head">
          <img
            className="landing-sheet-avatar"
            src="/brand/logos/logo_white_orangebg.svg"
            alt=""
            width={423}
            height={423}
          />
          <strong>Eliza</strong>
          <span>
            {t("homepage_eliza.landing.contactSheetSubtitle", {
              defaultValue: "Reach me wherever you already message.",
            })}
          </span>
        </header>
        <div className="landing-sheet-options">
          <button type="button" className="landing-sheet-row" onClick={onText}>
            <IMessageIcon className="size-6" style={{ color: "#34C759" }} />
            {t("homepage_eliza.landing.channelImessage", {
              defaultValue: "Text Eliza on iMessage",
            })}
          </button>
          <a className="landing-sheet-row" href={`tel:${ELIZA_PHONE_NUMBER}`}>
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="size-6"
              aria-hidden="true"
            >
              <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02Z" />
            </svg>
            {t("homepage_eliza.landing.channelPhone", {
              defaultValue: "Call Eliza",
            })}
          </a>
          <a
            className="landing-sheet-row"
            href={buildElizaTelegramHref()}
            target="_blank"
            rel="noreferrer"
          >
            <TelegramIcon className="size-6" style={{ color: "#2AABEE" }} />
            {t("homepage_eliza.landing.channelTelegram", {
              defaultValue: "Message Eliza on Telegram",
            })}
          </a>
          <a
            className="landing-sheet-row"
            href={buildElizaDiscordHref()}
            target="_blank"
            rel="noreferrer"
          >
            <DiscordIcon className="size-6" style={{ color: "#5865F2" }} />
            {t("homepage_eliza.landing.channelDiscord", {
              defaultValue: "Message Eliza on Discord",
            })}
          </a>
          <a
            className="landing-sheet-row landing-sheet-row--account"
            href={accountHref}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-6"
              aria-hidden="true"
            >
              <path d="M17.5 19a4.5 4.5 0 0 0 .4-8.98 6 6 0 0 0-11.63-1.4A4.25 4.25 0 0 0 6.5 19h11Z" />
            </svg>
            {accountLabel}
          </a>
        </div>
        <button type="button" className="landing-sheet-close" onClick={onClose}>
          {t("homepage_eliza.landing.contactSheetClose", {
            defaultValue: "Close",
          })}
        </button>
      </div>
    </dialog>
  );
}

const SESSION_STORAGE_KEY = "eliza_app_session";

export default function LandingPage() {
  const t = useT();
  const [phoneCopyState, setPhoneCopyState] = useState<
    "idle" | "handoff" | "copied" | "error"
  >("idle");
  const phoneCopyOperation = useRef(0);
  const browserWindow = typeof window === "undefined" ? null : window;
  const signedIn =
    browserWindow !== null &&
    browserWindow.localStorage.getItem(SESSION_STORAGE_KEY) !== null;
  const productNavigation = resolveHomepageProductNavigation(
    browserWindow?.location.hostname ?? "",
  );
  const [contactSheetOpen, setContactSheetOpen] = useState(false);
  const channels = [
    {
      key: "telegram",
      href: buildElizaTelegramHref(),
      shortLabel: t("homepage_eliza.getStarted.btnTelegram", {
        defaultValue: "Telegram",
      }),
      label: t("homepage_eliza.landing.channelTelegram", {
        defaultValue: "Message Eliza on Telegram",
      }),
      icon: <TelegramIcon className="size-6" style={{ color: "#2AABEE" }} />,
    },
    {
      key: "discord",
      href: buildElizaDiscordHref(),
      shortLabel: t("homepage_eliza.getStarted.btnDiscord", {
        defaultValue: "Discord",
      }),
      label: t("homepage_eliza.landing.channelDiscord", {
        defaultValue: "Message Eliza on Discord",
      }),
      icon: <DiscordIcon className="size-6" style={{ color: "#5865F2" }} />,
    },
  ];

  const handleMessageEliza = async () => {
    const operation = ++phoneCopyOperation.current;
    try {
      const outcome = await openOrCopyElizaMessage(window);
      if (operation === phoneCopyOperation.current) setPhoneCopyState(outcome);
    } catch {
      // error-policy:J4 Clipboard rejection stays visible as a distinct UI error.
      if (operation === phoneCopyOperation.current) setPhoneCopyState("error");
    }
  };

  const handleCopyPhone = async () => {
    const operation = ++phoneCopyOperation.current;
    try {
      await navigator.clipboard.writeText(ELIZA_PHONE_NUMBER);
      if (operation === phoneCopyOperation.current) setPhoneCopyState("copied");
    } catch {
      // error-policy:J4 Clipboard rejection stays visible as a distinct UI error.
      if (operation === phoneCopyOperation.current) setPhoneCopyState("error");
    }
  };

  const phoneCopyLabel =
    phoneCopyState === "copied"
      ? t("homepage_eliza.landing.phoneCopied", {
          defaultValue: "Copied!",
        })
      : phoneCopyState === "handoff"
        ? t("homepage_eliza.common.messageHandoff", {
            defaultValue:
              "Opening Messages. If nothing happens, copy the number.",
          })
        : t("homepage_eliza.landing.phoneCopyFailed", {
            defaultValue: "Couldn't copy",
          });
  return (
    <div className="landing-page theme-app">
      <DeferredShaderBackground />
      <div aria-hidden="true" className="landing-grain" />
      <header className="landing-header">
        <a
          className="landing-brand"
          href="/"
          aria-label={t("homepage_eliza.landing.brandAria", {
            defaultValue: "Eliza",
          })}
        >
          <img
            className="landing-brand-mark"
            src="/brand/logos/logo_white_orangebg.svg"
            alt=""
          />
          <img
            className="landing-brand-wordmark"
            src="/brand/logos/eliza_text_black.svg"
            alt=""
          />
        </a>
        <a
          className="landing-cta landing-cta--white landing-header-cta"
          href={
            signedIn
              ? productNavigation.dashboardUrl
              : productNavigation.signInUrl
          }
        >
          {signedIn
            ? t("homepage_eliza.landing.dashboard", {
                defaultValue: "Dashboard",
              })
            : t("homepage_eliza.landing.signIn", { defaultValue: "Sign in" })}
        </a>
      </header>
      <main className="landing-hero">
        <div className="landing-hero-copy">
          <h1 className="landing-hero-heading">
            {t("homepage_eliza.landing.heroTitle", {
              defaultValue: "The one member every group chat needs.",
            })}
          </h1>
          <p className="landing-hero-lede">
            {t("homepage_eliza.landing.heroLede", {
              defaultValue:
                "Eliza follows the conversation, remembers what the group decides, and keeps the plan clear.",
            })}
          </p>
          <div className="landing-hero-actions">
            <button
              type="button"
              className="landing-cta landing-cta--black"
              onClick={() => void handleMessageEliza()}
            >
              <IMessageIcon className="size-5" />
              {t("homepage_eliza.landing.ctaText", {
                defaultValue: "Text Eliza",
              })}
            </button>
            <a
              className="landing-cta landing-cta--white"
              href={`tel:${ELIZA_PHONE_NUMBER}`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="size-5"
                aria-hidden="true"
              >
                <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02Z" />
              </svg>
              {t("homepage_eliza.landing.ctaCall", {
                defaultValue: "Call",
              })}
            </a>
          </div>
          <div className="landing-secondary-channels">
            {channels.map((channel) => (
              <a
                key={channel.key}
                className="landing-channel"
                href={channel.href}
                aria-label={channel.label}
                title={channel.label}
                target="_blank"
                rel="noreferrer"
              >
                {channel.icon}
                <span>{channel.shortLabel}</span>
              </a>
            ))}
          </div>
          {phoneCopyState !== "idle" && (
            <div
              className={`landing-copy-notice landing-copy-notice--${phoneCopyState}`}
            >
              <span
                role={phoneCopyState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {phoneCopyLabel}
              </span>
              {phoneCopyState === "handoff" && (
                <button
                  type="button"
                  className="landing-copy-notice-action"
                  onClick={() => void handleCopyPhone()}
                >
                  {t("homepage_eliza.connected.copyPhoneAria", {
                    defaultValue: "Copy phone number",
                  })}
                </button>
              )}
            </div>
          )}
        </div>
        <ResponsivePhoneMockup />
        <button
          type="button"
          className="landing-tap-target"
          onClick={() => setContactSheetOpen(true)}
          aria-label={t("homepage_eliza.landing.contactSheetOpen", {
            defaultValue: "All the ways to reach Eliza",
          })}
        />
      </main>
      <ContactSheet
        open={contactSheetOpen}
        onClose={() => setContactSheetOpen(false)}
        onText={() => {
          setContactSheetOpen(false);
          void handleMessageEliza();
        }}
        accountHref={
          signedIn
            ? productNavigation.dashboardUrl
            : productNavigation.signInUrl
        }
        accountLabel={
          signedIn
            ? t("homepage_eliza.landing.dashboard", {
                defaultValue: "Open your dashboard",
              })
            : t("homepage_eliza.landing.signInCloud", {
                defaultValue: "Sign in to Eliza Cloud",
              })
        }
      />
    </div>
  );
}
