/**
 * Screen gallery — representative archetypes covering the app's screen families,
 * each authored ONCE with the spatial vocabulary. The gallery is the verification
 * corpus: every screen here is rendered to GUI, XR and TUI (see the stories
 * harness `stories/src/spatial-gallery.tsx` and `__tests__/gallery.test.tsx`).
 *
 * These are presentational (props baked in) so they render identically and
 * deterministically on every surface with no data fetching.
 */

import { AgentProfileView } from "./example.tsx";
import {
  Button,
  Card,
  Divider,
  Field,
  HStack,
  List,
  Spacer,
  Text,
  VStack,
} from "./index.ts";

export interface GalleryScreen {
  id: string;
  title: string;
  description: string;
  /** Authored once; rendered to GUI/XR (DOM) and TUI (terminal) unchanged. */
  view: () => React.ReactNode;
  /** Suggested terminal width for the TUI rendering of this screen. */
  tuiWidth?: number;
}

// 1 — Detail / profile card --------------------------------------------------
function ProfileScreen() {
  return (
    <AgentProfileView
      profile={{
        name: "Ada",
        status: "online",
        model: "eliza-1",
        skills: ["research", "coding", "scheduling", "memory"],
      }}
    />
  );
}

// 2 — Conversation list ------------------------------------------------------
function MessagesScreen() {
  const threads = [
    {
      name: "Eliza",
      preview: "Deployed the build — all green.",
      time: "2m",
      unread: 2,
    },
    {
      name: "Ops",
      preview: "headscale route confirmed",
      time: "1h",
      unread: 0,
    },
    { name: "Research", preview: "3 new papers queued", time: "4h", unread: 1 },
  ];
  return (
    <Card title="Messages" gap={1} padding={1}>
      {threads.map((t) => (
        <HStack key={t.name} gap={1} align="center" agent={`thread:${t.name}`}>
          <VStack gap={0} grow={1}>
            <HStack gap={1}>
              <Text bold grow={1}>
                {t.name}
              </Text>
              <Text style="caption" tone="muted">
                {t.time}
              </Text>
            </HStack>
            <Text style="caption" tone="muted" wrap={false}>
              {t.preview}
            </Text>
          </VStack>
          {t.unread > 0 ? <Text tone="primary">{`(${t.unread})`}</Text> : null}
        </HStack>
      ))}
    </Card>
  );
}

// 3 — Settings form ----------------------------------------------------------
function SettingsScreen() {
  return (
    <Card title="Settings" gap={1} padding={1}>
      <Field label="Display name" value="Ada" />
      <Field
        label="Model"
        kind="select"
        value="eliza-1"
        options={["eliza-1", "gpt-5.5", "claude"]}
      />
      <Field label="API key" kind="password" value="sk-secret" />
      <Divider />
      <HStack gap={1} justify="between">
        <Text tone="muted" style="caption" grow={1}>
          Voice replies
        </Text>
        <Text tone="success">On</Text>
      </HStack>
      <HStack gap={1} justify="end" wrap>
        <Button variant="ghost" tone="default" agent="cancel">
          Cancel
        </Button>
        <Button agent="save">Save changes</Button>
      </HStack>
    </Card>
  );
}

// 4 — Dashboard / stats ------------------------------------------------------
function DashboardScreen() {
  const stats = [
    { label: "Agents", value: "12", tone: "primary" as const },
    { label: "Active", value: "9", tone: "success" as const },
    { label: "Errors", value: "1", tone: "danger" as const },
  ];
  // Borderless stat blocks (tone-coloured numbers) — no nested boxes.
  return (
    <Card title="Overview" gap={1} padding={1}>
      <HStack gap={3} wrap>
        {stats.map((s) => (
          <VStack key={s.label} gap={0} grow={1}>
            <Text style="heading" tone={s.tone}>
              {s.value}
            </Text>
            <Text style="caption" tone="muted">
              {s.label}
            </Text>
          </VStack>
        ))}
      </HStack>
      <Divider label="recent" />
      <List gap={0}>
        <Text tone="muted">• deploy #482 succeeded</Text>
        <Text tone="muted">• 3 messages routed</Text>
      </List>
    </Card>
  );
}

// 5 — Chat transcript --------------------------------------------------------
function ChatScreen() {
  // Speaker label + message, no bubble boxes — clean terminal chat rhythm.
  return (
    <Card title="Chat" gap={1} padding={1}>
      <VStack gap={0}>
        <Text tone="muted" style="caption">
          you
        </Text>
        <Text>What's the deploy status?</Text>
      </VStack>
      <VStack gap={0}>
        <Text tone="primary" style="caption">
          eliza
        </Text>
        <Text>Build #482 is live. All checks green.</Text>
      </VStack>
      <Divider />
      <Field placeholder="Message…" agent="composer" />
    </Card>
  );
}

// 6 — Empty state ------------------------------------------------------------
function EmptyScreen() {
  return (
    <Card gap={1} padding={2} align="center">
      <Text style="heading" align="center">
        No views yet
      </Text>
      <Text tone="muted" align="center">
        Install an app to add a view to your dashboard.
      </Text>
      <Spacer size={1} />
      <Button agent="browse">Browse apps</Button>
    </Card>
  );
}

// 7 — Error state ------------------------------------------------------------
function ErrorScreen() {
  return (
    <Card gap={1} padding={2} border="double" tone="danger" align="center">
      <Text style="heading" tone="danger" align="center">
        Something went wrong
      </Text>
      <Text tone="muted" align="center">
        The view failed to load. Check the agent logs and try again.
      </Text>
      <HStack gap={1} justify="center" wrap>
        <Button variant="outline" tone="default" agent="logs">
          View logs
        </Button>
        <Button tone="danger" agent="retry">
          Retry
        </Button>
      </HStack>
    </Card>
  );
}

// 8 — Connect / login --------------------------------------------------------
// Full-width stacked actions: `width="100%"` fills the container in every
// modality, unlike a fixed cell width (which is 0.25rem in DOM but a whole
// column in the terminal — they don't translate).
function ConnectScreen() {
  return (
    <Card title="Connect" gap={1} padding={2}>
      <Text style="heading" align="center">
        Sign in to Eliza Cloud
      </Text>
      <Text tone="muted" align="center" style="caption">
        Optional — local mode works without an account.
      </Text>
      <Spacer size={1} />
      <Button width="100%" agent="wallet">
        Continue with wallet
      </Button>
      <Button variant="outline" tone="default" width="100%" agent="email">
        Continue with email
      </Button>
    </Card>
  );
}

// 9 — Wallet / balance -------------------------------------------------------
function WalletScreen() {
  const tokens = [
    { sym: "SOL", amt: "12.40", fiat: "$1,984" },
    { sym: "USDC", amt: "350.00", fiat: "$350" },
  ];
  return (
    <Card title="Wallet" gap={1} padding={1}>
      <VStack gap={0} align="center">
        <Text style="heading">$2,334.00</Text>
        <Text style="caption" tone="muted">
          total balance
        </Text>
      </VStack>
      <Divider />
      <List gap={0}>
        {tokens.map((t) => (
          <HStack key={t.sym} gap={1}>
            <Text bold grow={1}>
              {t.sym}
            </Text>
            <Text>{t.amt}</Text>
            <Text tone="muted">{t.fiat}</Text>
          </HStack>
        ))}
      </List>
      <HStack gap={1} justify="between" wrap>
        <Button grow={1} agent="send">
          Send
        </Button>
        <Button variant="outline" tone="default" grow={1} agent="receive">
          Receive
        </Button>
      </HStack>
    </Card>
  );
}

// 10 — Data table ------------------------------------------------------------
function TableScreen() {
  const rows = [
    { job: "deploy-482", status: "done", tone: "success" as const },
    { job: "deploy-483", status: "building", tone: "warning" as const },
    { job: "deploy-484", status: "failed", tone: "danger" as const },
  ];
  return (
    <Card title="Jobs" gap={0} padding={1}>
      <HStack gap={1}>
        <Text style="label" tone="muted" grow={1}>
          JOB
        </Text>
        <Text style="label" tone="muted" width={10}>
          STATUS
        </Text>
      </HStack>
      <Divider />
      {rows.map((r) => (
        <HStack key={r.job} gap={1} agent={`row:${r.job}`}>
          <Text grow={1}>{r.job}</Text>
          <Text tone={r.tone} width={10}>
            {r.status}
          </Text>
        </HStack>
      ))}
    </Card>
  );
}

// 11 — Confirmation dialog ---------------------------------------------------
function ConfirmScreen() {
  return (
    <Card title="Confirm" gap={1} padding={2} border="double">
      <Text style="subheading">Delete this agent?</Text>
      <Text tone="muted">
        This removes the agent and its memory. This action cannot be undone.
      </Text>
      <HStack gap={1} justify="end" wrap>
        <Button variant="ghost" tone="default" agent="dismiss">
          Cancel
        </Button>
        <Button tone="danger" agent="confirm-delete">
          Delete
        </Button>
      </HStack>
    </Card>
  );
}

// 12 — Progress / status -----------------------------------------------------
function ProgressScreen() {
  const steps = [
    { label: "Clone repo", done: true },
    { label: "Build image", done: true },
    { label: "Provision host", done: false },
    { label: "Start agent", done: false },
  ];
  return (
    <Card title="Deploying…" gap={1} padding={1}>
      <List gap={0}>
        {steps.map((s) => (
          <HStack key={s.label} gap={1}>
            {/* ●/○ are width-1 in every terminal; ✓ is East-Asian-ambiguous
                (width 2 per the width table, 1 in many fonts) → misaligns. */}
            <Text tone={s.done ? "success" : "muted"}>
              {s.done ? "●" : "○"}
            </Text>
            <Text tone={s.done ? "default" : "muted"} grow={1}>
              {s.label}
            </Text>
          </HStack>
        ))}
      </List>
      <Divider />
      <HStack gap={1}>
        <Text tone="muted" style="caption" grow={1}>
          2 of 4 complete
        </Text>
        <Button variant="ghost" tone="danger" agent="abort">
          Abort
        </Button>
      </HStack>
    </Card>
  );
}

export const GALLERY: GalleryScreen[] = [
  {
    id: "profile",
    title: "Detail / profile card",
    description: "header, field, list, actions",
    view: ProfileScreen,
  },
  {
    id: "messages",
    title: "Conversation list",
    description: "rows, unread badges, truncation",
    view: MessagesScreen,
  },
  {
    id: "settings",
    title: "Settings form",
    description: "fields, select, password, actions",
    view: SettingsScreen,
  },
  {
    id: "dashboard",
    title: "Dashboard / stats",
    description: "stat cards, grow, tones",
    view: DashboardScreen,
  },
  {
    id: "chat",
    title: "Chat transcript",
    description: "bubbles, composer field",
    view: ChatScreen,
  },
  {
    id: "empty",
    title: "Empty state",
    description: "centered, single action",
    view: EmptyScreen,
  },
  {
    id: "error",
    title: "Error state",
    description: "double border, danger tone",
    view: ErrorScreen,
  },
  {
    id: "connect",
    title: "Connect / login",
    description: "full-width stacked actions",
    view: ConnectScreen,
  },
  {
    id: "wallet",
    title: "Wallet / balance",
    description: "totals, token rows, actions",
    view: WalletScreen,
  },
  {
    id: "table",
    title: "Data table",
    description: "column headers, status tones",
    view: TableScreen,
  },
  {
    id: "confirm",
    title: "Confirmation dialog",
    description: "destructive confirm",
    view: ConfirmScreen,
  },
  {
    id: "progress",
    title: "Progress / status",
    description: "step checklist",
    view: ProgressScreen,
  },
];
