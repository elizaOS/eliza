/**
 * Reference spatial view — authored ONCE, rendered to GUI, XR and TUI.
 *
 * This is the worked example for the framework: it uses the full primitive
 * vocabulary (Card/HStack/List/Text/Field/Divider/Button), cross-modal state
 * (`useSpatialState`), `.map`, and conditionals — yet carries no per-modality
 * branching. The same component instance renders to DOM on GUI/XR and to
 * terminal lines via the IR. See `__tests__/parity.test.tsx`.
 */

import {
  Button,
  Card,
  Divider,
  Field,
  HStack,
  List,
  Text,
  useSpatialState,
} from "./index.ts";
import type { SpatialTone } from "./ir.ts";

export interface AgentProfile {
  name: string;
  status: "online" | "idle" | "offline";
  model: string;
  skills: string[];
}

function statusTone(status: AgentProfile["status"]): SpatialTone {
  if (status === "online") return "success";
  if (status === "idle") return "warning";
  return "muted";
}

export function AgentProfileView({ profile }: { profile: AgentProfile }) {
  const [expanded, setExpanded] = useSpatialState(false);
  const visibleSkills = expanded ? profile.skills : profile.skills.slice(0, 2);
  const hiddenCount = profile.skills.length - visibleSkills.length;

  return (
    <Card title="Agent" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="heading" grow={1}>
          {profile.name}
        </Text>
        <Text tone={statusTone(profile.status)}>{profile.status}</Text>
      </HStack>

      <Field label="Model" value={profile.model} agent="model-field" />

      <Divider label="skills" />
      <List gap={0}>
        {visibleSkills.map((skill) => (
          <Text key={skill} tone="muted">
            • {skill}
          </Text>
        ))}
      </List>

      <HStack gap={1} justify="between" wrap>
        <Button onPress={() => setExpanded((v) => !v)} agent="toggle-skills">
          {expanded
            ? "Show less"
            : hiddenCount > 0
              ? `Show ${hiddenCount} more`
              : "Show all"}
        </Button>
        <Button variant="outline" tone="default" agent="configure">
          Configure
        </Button>
      </HStack>
    </Card>
  );
}
