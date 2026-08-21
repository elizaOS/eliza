/** Development-only board for reviewing every landing demo room at once. */

import {
  isLandingDemoAttachmentStep,
  LandingDemoAttachment,
} from "@/components/landing-demo-attachment";
import {
  LANDING_DEMO_MEMBER_AVATARS,
  LANDING_DEMO_SCENARIOS,
  type LandingDemoCapability,
  type LandingDemoStep,
  landingDemoStepText,
} from "@/lib/landing-demo";
import "./demo-scenarios.css";

const CAPABILITY_LABELS: Record<LandingDemoCapability, string> = {
  "connected-calendar": "Connected calendar",
  "conversation-memory": "Conversation context",
  "public-web-search": "Public web",
  "room-memory": "Room memory",
  "scheduled-reminder": "Reminder",
};

function stepSender(step: LandingDemoStep): string {
  if (step.kind === "member") return step.name;
  if (step.kind === "user") return "You";
  return "Eliza";
}

function stepCapability(step: LandingDemoStep): LandingDemoCapability | null {
  return step.kind === "member" || step.kind === "user"
    ? null
    : step.capability;
}

function senderAvatar(step: LandingDemoStep): string | null {
  if (step.kind !== "member" && step.kind !== "user") {
    return "/brand/logos/logo_white_orangebg.svg";
  }
  if (step.kind === "user") return null;
  return (
    LANDING_DEMO_MEMBER_AVATARS[
      step.name as keyof typeof LANDING_DEMO_MEMBER_AVATARS
    ] ?? null
  );
}

function stepKey(step: LandingDemoStep): string {
  return `${step.kind}-${landingDemoStepText(step)}`;
}

function sameStepSender(
  first: LandingDemoStep | undefined,
  second: LandingDemoStep | undefined,
): boolean {
  if (!first || !second) return false;
  return stepSender(first) === stepSender(second);
}

function ReviewStep({
  index,
  nextStep,
  previousStep,
  step,
}: {
  index: number;
  nextStep?: LandingDemoStep;
  previousStep?: LandingDemoStep;
  step: LandingDemoStep;
}) {
  const sender = stepSender(step);
  const avatar = senderAvatar(step);
  const showAuthor = !sameStepSender(previousStep, step);
  const showAvatar = !sameStepSender(step, nextStep);

  return (
    <li
      className={`demo-review-step demo-review-step--${step.kind}`}
      data-demo-review-step={step.kind}
    >
      <span className="demo-review-number">{index + 1}</span>
      <span className="demo-review-avatar-slot">
        {avatar && showAvatar ? (
          <img
            src={avatar}
            alt=""
            width={256}
            height={256}
            loading="lazy"
            decoding="async"
          />
        ) : null}
      </span>
      <div className="demo-review-step-body">
        {showAuthor ? (
          <div className="demo-review-step-meta">
            <strong>{sender}</strong>
          </div>
        ) : null}
        {isLandingDemoAttachmentStep(step) ? (
          <LandingDemoAttachment step={step} />
        ) : (
          <p>{step.text}</p>
        )}
      </div>
    </li>
  );
}

export default function DemoScenariosPage() {
  return (
    <main className="demo-review-page">
      <header className="demo-review-header">
        <div>
          <a href="/">← Homepage</a>
          <p>Development review</p>
          <h1>Group chat demo scripts</h1>
          <span className="demo-review-subtitle">
            One shared mobile + desktop source · natural iMessage conversations
          </span>
          <span className="demo-review-editor-note">
            Edit <code>packages/homepage/src/lib/landing-demo.ts</code>. This
            board and the homepage update together.
          </span>
        </div>
        <nav aria-label="Scenario shortcuts">
          {LANDING_DEMO_SCENARIOS.map((scenario) => (
            <a key={scenario.id} href={`#${scenario.id}`}>
              {scenario.roomName}
            </a>
          ))}
        </nav>
      </header>

      <div className="demo-review-grid">
        {LANDING_DEMO_SCENARIOS.map((scenario) => {
          const capabilities = Array.from(
            new Set(
              scenario.steps.flatMap((step) => {
                const capability = stepCapability(step);
                return capability ? [capability] : [];
              }),
            ),
          );

          return (
            <section
              id={scenario.id}
              className="demo-review-room"
              data-demo-review-room={scenario.id}
              key={scenario.id}
            >
              <header className="demo-review-room-header">
                <div className="demo-review-cast" aria-hidden="true">
                  {scenario.members.map((member) => (
                    <img
                      key={member}
                      src={
                        LANDING_DEMO_MEMBER_AVATARS[
                          member as keyof typeof LANDING_DEMO_MEMBER_AVATARS
                        ]
                      }
                      alt=""
                      width={256}
                      height={256}
                      loading="lazy"
                      decoding="async"
                    />
                  ))}
                  <img
                    src="/brand/logos/logo_white_orangebg.svg"
                    alt=""
                    width={423}
                    height={423}
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <div>
                  <p>{scenario.label}</p>
                  <h2>{scenario.roomName}</h2>
                  <span className="demo-review-room-members">
                    {`${scenario.members.length + 2} people`}
                  </span>
                </div>
                <strong>{scenario.steps.length} beats</strong>
              </header>

              <div className="demo-review-capabilities">
                {capabilities.map((capability) => (
                  <span className="demo-review-capability" key={capability}>
                    {CAPABILITY_LABELS[capability]}
                  </span>
                ))}
              </div>

              <ol className="demo-review-script">
                {scenario.steps.map((step, index) => (
                  <ReviewStep
                    index={index}
                    key={`${scenario.id}-${stepKey(step)}`}
                    nextStep={scenario.steps[index + 1]}
                    previousStep={scenario.steps[index - 1]}
                    step={step}
                  />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
    </main>
  );
}
