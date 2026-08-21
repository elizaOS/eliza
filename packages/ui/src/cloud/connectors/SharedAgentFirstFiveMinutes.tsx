/**
 * Provides the Cloud connector console's first-five-minutes walkthrough and
 * truthful first-interaction contracts for Telegram, Blooio/iMessage, and
 * Twilio Voice. It describes the single-agent boundary and current transport
 * limits while existing connector cards continue to own credential mutation.
 */

"use client";

import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  MessageCircle,
  PhoneCall,
  RotateCcw,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { JSX } from "react";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";

export type SharedAgentConnectorGuideId = "telegram" | "blooio" | "twilio";

interface SharedAgentConnectorGuide {
  label: string;
  status: string;
  setup: string[];
  firstProof: string[];
  responsePolicy: string;
  identityAndContinuity: string;
  duplicateSafety: string;
  groupBehavior: string;
  recovery: string[];
}

export const SHARED_AGENT_CONNECTOR_GUIDES: Record<
  SharedAgentConnectorGuideId,
  SharedAgentConnectorGuide
> = {
  telegram: {
    label: "Telegram",
    status: "Hosted direct messages",
    setup: [
      "Create a bot with @BotFather and paste its token only into the protected token field below. This bot is a connector identity for your existing Eliza, not a second agent.",
      "Connect the bot, open its Telegram profile, and press Start. If the token was ever exposed, revoke it in @BotFather before reconnecting.",
    ],
    firstProof: [
      'In the web chat, tell Eliza: "My first Telegram check is next."',
      'In the bot DM, send: "What check did I say was next?"',
      "Accept the connector only after the inbound message and one reply are visible in the same DM. A connected badge alone is not conversation proof.",
    ],
    responsePolicy:
      "The hosted Telegram ingress currently accepts private bot chats. A DM is routed to the signed-in sender's canonical Eliza, which may reply or deliberately stay silent.",
    identityAndContinuity:
      "The Telegram sender identity is explicitly linked to the same Eliza account and agent used on the web; the bot token remains a separate connector credential.",
    duplicateSafety:
      "Telegram update IDs and provider message IDs drive the replay ledger. Delivery retries resume or stop at the recorded boundary instead of emitting a second reply.",
    groupBehavior:
      "Hosted Telegram groups and supergroups are not enabled yet. The local Telegram connector supports them with explicit privacy, allowlist, and auto-reply controls; do not promote this hosted bot or promise group replies until the hosted capability is enabled.",
    recovery: [
      "If Start produces no reply, refresh status, verify the exact bot username, and retry one DM. Do not rotate the token unless the status error identifies credentials.",
      "Disconnect to remove the Cloud binding. Reconnect the same bot to preserve the public bot identity; use @BotFather to revoke a compromised token.",
    ],
  },
  blooio: {
    label: "iMessage",
    status: "Hosted Blooio DMs; local BlueBubbles groups",
    setup: [
      "Choose one transport: Blooio is the hosted provider path; BlueBubbles is the user-owned Mac bridge. Both route to the same Eliza and keep their provider credentials in separate trust domains.",
      "For Blooio, connect the API key and number, copy the generated webhook URL into Blooio, then save the webhook signing secret. A connection is incomplete until Webhook Active appears.",
      "For BlueBubbles, keep the Mac awake and signed into Messages, grant BlueBubbles Full Disk Access and requested Automation access, then verify the server URL, password, and Eliza webhook target from local connector settings.",
    ],
    firstProof: [
      'In web chat, tell Eliza: "Remember that this is my iMessage continuity check."',
      'From an approved phone or email handle, send: "What kind of check is this?"',
      "Accept the connector only after the webhook records one inbound provider message and the same DM or BlueBubbles chat receives one reply.",
    ],
    responsePolicy:
      "Blooio hosted delivery currently accepts one-to-one messages. Local BlueBubbles defaults DMs to owner pairing and groups to a sender allowlist; an allowed turn may still result in deliberate agent silence.",
    identityAndContinuity:
      "Normalized phone/email handles identify participants. Blooio DMs use the provider sender, while BlueBubbles uses the stable chat GUID so a DM or group reply returns to the exact Messages thread.",
    duplicateSafety:
      "Blooio requires a stable provider message ID and uses it for ingress dedupe and outbound idempotency. BlueBubbles stores each message GUID once and holds concurrent replays before another agent turn starts.",
    groupBehavior:
      "Blooio group webhooks are intentionally rejected today. For supported iMessage groups, use the local BlueBubbles connector: add the Mac's Messages identity to the group, configure the group allowlist, and remember that there is no mention-only transport gate.",
    recovery: [
      "Blooio: verify Webhook Active, signing secret, number, and provider delivery log; then retry one new message, never the same provider event.",
      "BlueBubbles: verify Messages sign-in, Full Disk Access, Automation, Mac wake state, server reachability, webhook target, and the sender allowlist before reconnecting.",
      "Disconnect or remove the Messages participant to stop delivery. Reconnect the same number/account to preserve participant and thread identity.",
    ],
  },
  twilio: {
    label: "Twilio Voice",
    status: "One-to-one inbound and verified-number outbound calls",
    setup: [
      "Use a Twilio account and an E.164 voice-capable number you control. Trial accounts must verify the destination. Paste the Account SID, Auth Token, and number only into the protected fields below.",
      "Keep the visible Twilio number as caller identity. Before a real probe, tell the participant they are calling an AI agent and follow applicable consent or recording-disclosure rules.",
    ],
    firstProof: [
      "Inbound: call the configured Eliza number, hear the opening greeting, say your name, and ask about one fact from the web conversation.",
      "Outbound: from web chat, use the phone control and confirm the masked destination. The public call route permits only the phone number already verified on your Eliza account.",
      "Accept the connector after caller/called-number mapping, audible two-way speech, continuity, and clean hangup are all observed. A queued call SID is not answered-call proof.",
    ],
    responsePolicy:
      "Calls are one-to-one realtime voice sessions. The remote phone's native hangup ends the media stream. Capacity, provider, or bootstrap failure closes the call rather than continuing in a false-success state.",
    identityAndContinuity:
      "Inbound and outbound direction are normalized into the public Eliza line and the remote caller. Returning calls reuse the canonical agent conversation scope and receive a continuity-aware opening.",
    duplicateSafety:
      "Outbound requests require an idempotency key. An ambiguous provider result retains its claim, so retrying the same request cannot silently place a second paid call.",
    groupBehavior:
      "Conference and group-call participation are not supported. Do not add Eliza to a conference: multi-party consent, participant identity, diarization, removal, and conference lifecycle need a separate owned design before launch.",
    recovery: [
      "If no call arrives, verify the Eliza account phone is verified, the destination is E.164, the Twilio number is voice-capable, trial restrictions are satisfied, and status shows the webhook active.",
      "Hang up a stuck call from the phone. Refresh connector status before a new request; never replay an ambiguous call request just because the UI timed out.",
      "Disconnecting stops new connector traffic. Reconnect the same Twilio number when caller identity should remain stable.",
    ],
  },
};

const connectorIcons: Record<SharedAgentConnectorGuideId, JSX.Element> = {
  telegram: <MessageCircle className="h-4 w-4" aria-hidden="true" />,
  blooio: <Users className="h-4 w-4" aria-hidden="true" />,
  twilio: <PhoneCall className="h-4 w-4" aria-hidden="true" />,
};

export function SharedAgentFirstFiveMinutes() {
  return (
    <section
      className="space-y-4 rounded-sm border border-accent/35 bg-card/65 p-4 shadow-sm md:p-5"
      aria-labelledby="shared-agent-first-five-title"
      data-testid="shared-agent-first-five-minutes"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent text-accent-foreground">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-accent">
            Your first five minutes
          </div>
          <h2
            id="shared-agent-first-five-title"
            className="text-lg font-semibold text-txt"
          >
            One Eliza, every conversation
          </h2>
          <p className="max-w-3xl text-sm text-muted">
            Web, messaging, and calls route into your canonical Eliza agent and
            runtime. Each provider keeps its own connector identity and
            credential boundary; connecting a channel never creates a second
            agent or a second secret store.
          </p>
        </div>
      </div>

      <ol className="grid gap-2 text-sm md:grid-cols-3">
        <li className="rounded-sm border border-border/45 bg-bg/55 p-3">
          <div className="font-semibold text-txt">1. Meet on the web</div>
          <p className="mt-1 text-xs text-muted">
            Open chat, finish sign-in/agent creation, and get one real reply.
            Give Eliza a short fact you can ask for on another channel.
          </p>
          <a
            href="/chat"
            className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-accent underline-offset-4 hover:underline"
          >
            Open web chat{" "}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </li>
        <li className="rounded-sm border border-border/45 bg-bg/55 p-3">
          <div className="font-semibold text-txt">2. Connect one channel</div>
          <p className="mt-1 text-xs text-muted">
            Start with one card below. Complete its provider setup and webhook
            requirements before moving on; a green credential probe is not an
            inbound/outbound proof.
          </p>
        </li>
        <li className="rounded-sm border border-border/45 bg-bg/55 p-3">
          <div className="font-semibold text-txt">3. Prove continuity</div>
          <p className="mt-1 text-xs text-muted">
            After you authorize the exact live probe, ask about the web fact.
            Confirm the same agent replies in the same DM, thread, or call and
            that removal/reconnect behaves visibly.
          </p>
        </li>
      </ol>

      <div className="grid gap-2 md:grid-cols-3">
        {(
          Object.keys(
            SHARED_AGENT_CONNECTOR_GUIDES,
          ) as SharedAgentConnectorGuideId[]
        ).map((connector) => {
          const guide = SHARED_AGENT_CONNECTOR_GUIDES[connector];
          return (
            <a
              key={connector}
              href={`#${connector}-connection`}
              className="flex min-h-11 items-center justify-between gap-3 rounded-sm border border-border/45 bg-card/55 px-3 py-2 text-sm transition-colors hover:border-accent/55 hover:bg-accent/10"
            >
              <span className="flex items-center gap-2 font-semibold text-txt">
                {connectorIcons[connector]}
                {guide.label}
              </span>
              <Badge
                variant="outline"
                className="max-w-[14rem] whitespace-normal text-right text-xs"
              >
                {guide.status}
              </Badge>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function GuideList({ items }: { items: string[] }) {
  return (
    <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

export function ConnectorFirstInteractionGuide({
  connector,
  className,
}: {
  connector: SharedAgentConnectorGuideId;
  className?: string;
}) {
  const guide = SHARED_AGENT_CONNECTOR_GUIDES[connector];

  return (
    <details
      className={cn(
        "group rounded-sm border border-border/50 bg-muted/35 p-3",
        className,
      )}
      data-testid={`${connector}-first-interaction-guide`}
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-col items-stretch justify-center gap-2 py-1.5 font-semibold text-foreground marker:hidden sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2">
          {connectorIcons[connector]}
          First successful {guide.label} interaction
        </span>
        <span className="flex items-center justify-between gap-2 sm:justify-end">
          <Badge
            variant="outline"
            className="max-w-[16rem] whitespace-normal text-left text-xs sm:text-right"
          >
            {guide.status}
          </Badge>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>

      <div className="space-y-3 border-t border-border/45 pt-3">
        <div>
          <div className="mb-1.5 font-semibold text-foreground">
            Setup and prerequisites
          </div>
          <GuideList items={guide.setup} />
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
            <CheckCircle2
              className="h-3.5 w-3.5 text-accent"
              aria-hidden="true"
            />
            Live proof checklist
          </div>
          <GuideList items={guide.firstProof} />
        </div>
        <dl className="grid gap-2 text-xs md:grid-cols-2">
          <div className="rounded-sm border border-border/40 bg-background/45 p-2.5">
            <dt className="font-semibold text-foreground">Response policy</dt>
            <dd className="mt-1 text-muted-foreground">
              {guide.responsePolicy}
            </dd>
          </div>
          <div className="rounded-sm border border-border/40 bg-background/45 p-2.5">
            <dt className="font-semibold text-foreground">
              Participant identity and continuity
            </dt>
            <dd className="mt-1 text-muted-foreground">
              {guide.identityAndContinuity}
            </dd>
          </div>
          <div className="rounded-sm border border-border/40 bg-background/45 p-2.5">
            <dt className="font-semibold text-foreground">
              Duplicate suppression
            </dt>
            <dd className="mt-1 text-muted-foreground">
              {guide.duplicateSafety}
            </dd>
          </div>
          <div className="rounded-sm border border-border/40 bg-background/45 p-2.5">
            <dt className="font-semibold text-foreground">
              Group and conference behavior
            </dt>
            <dd className="mt-1 text-muted-foreground">
              {guide.groupBehavior}
            </dd>
          </div>
        </dl>
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
            <RotateCcw className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            Failure, removal, and reconnect
          </div>
          <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
            {guide.recovery.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}
