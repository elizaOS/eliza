import { useState } from "react";
import type { StoryDefinition } from "../Story.tsx";

import { Alert, AlertDescription, AlertTitle } from "@ui-src/components/ui/alert.tsx";
import { Badge } from "@ui-src/components/ui/badge.tsx";
import { Button } from "@ui-src/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@ui-src/components/ui/card.tsx";
import { Checkbox } from "@ui-src/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ui-src/components/ui/dialog.tsx";
import { Input } from "@ui-src/components/ui/input.tsx";
import { Label } from "@ui-src/components/ui/label.tsx";
import { Progress } from "@ui-src/components/ui/progress.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-src/components/ui/select.tsx";
import { Separator } from "@ui-src/components/ui/separator.tsx";
import { Skeleton } from "@ui-src/components/ui/skeleton.tsx";
import { Spinner } from "@ui-src/components/ui/spinner.tsx";
import { StatusBadge, StatusDot } from "@ui-src/components/ui/status-badge.tsx";
import { Switch } from "@ui-src/components/ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui-src/components/ui/tabs.tsx";
import { Textarea } from "@ui-src/components/ui/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@ui-src/components/ui/tooltip.tsx";
import { Heading, Text } from "@ui-src/components/ui/typography.tsx";

function ControlledSwitch() {
  const [on, setOn] = useState(true);
  return <Switch checked={on} onCheckedChange={setOn} />;
}

function ControlledCheckbox() {
  const [on, setOn] = useState(true);
  return (
    <Checkbox
      checked={on}
      onCheckedChange={(v: boolean | "indeterminate") => setOn(v === true)}
    />
  );
}

export const primitiveStories: StoryDefinition[] = [
  {
    name: "Alert",
    importPath: 'import { Alert, AlertTitle, AlertDescription } from "@elizaos/ui/components/ui/alert"',
    render: () => (
      <div style={{ display: "grid", gap: 12, width: "100%" }}>
        <Alert>
          <AlertTitle>Connected.</AlertTitle>
          <AlertDescription>Your local agent is online.</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>Inference failed</AlertTitle>
          <AlertDescription>Model `eliza-1` is not downloaded.</AlertDescription>
        </Alert>
      </div>
    ),
  },
  {
    name: "Badge",
    importPath: 'import { Badge } from "@elizaos/ui/components/ui/badge"',
    render: () => (
      <>
        <Badge>Default</Badge>
        <Badge variant="secondary">Local</Badge>
        <Badge variant="outline">Optional</Badge>
        <Badge variant="destructive">Failed</Badge>
      </>
    ),
  },
  {
    name: "Button",
    importPath: 'import { Button } from "@elizaos/ui/components/ui/button"',
    render: () => (
      <>
        <Button>Run in Cloud</Button>
        <Button variant="secondary">Install elizaOS</Button>
        <Button variant="outline">Open Workspace</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="destructive">Delete agent</Button>
        <Button variant="link">Docs</Button>
        <Button disabled>Disabled</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
      </>
    ),
  },
  {
    name: "Card",
    importPath: 'import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@elizaos/ui/components/ui/card"',
    render: () => (
      <Card style={{ maxWidth: 360 }}>
        <CardHeader>
          <CardTitle>Eliza Cloud</CardTitle>
          <CardDescription>Managed inference, billing, and deploys.</CardDescription>
        </CardHeader>
        <CardContent>
          <Text>Sign in once. Use it everywhere.</Text>
        </CardContent>
        <CardFooter>
          <Button>Connect</Button>
        </CardFooter>
      </Card>
    ),
  },
  {
    name: "Checkbox",
    importPath: 'import { Checkbox } from "@elizaos/ui/components/ui/checkbox"',
    render: () => (
      <>
        <ControlledCheckbox />
        <Checkbox disabled />
      </>
    ),
  },
  {
    name: "Dialog",
    importPath: 'import { Dialog, DialogTrigger, DialogContent, ... } from "@elizaos/ui/components/ui/dialog"',
    render: () => (
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Open dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm deploy</DialogTitle>
            <DialogDescription>This will publish your agent to Eliza Cloud.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost">Cancel</Button>
            <Button>Deploy</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  },
  {
    name: "Input + Label",
    importPath: 'import { Input } from "@elizaos/ui/components/ui/input"',
    render: () => (
      <div style={{ display: "grid", gap: 6, width: 260 }}>
        <Label htmlFor="agent-name">Agent name</Label>
        <Input id="agent-name" placeholder="eliza-1" defaultValue="" />
        <Input placeholder="disabled" disabled />
      </div>
    ),
  },
  {
    name: "Progress",
    importPath: 'import { Progress } from "@elizaos/ui/components/ui/progress"',
    render: () => (
      <div style={{ width: 280, display: "grid", gap: 8 }}>
        <Progress value={20} />
        <Progress value={62} />
        <Progress value={100} />
      </div>
    ),
  },
  {
    name: "Select",
    importPath: 'import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@elizaos/ui/components/ui/select"',
    render: () => (
      <Select defaultValue="eliza-1">
        <SelectTrigger style={{ width: 200 }}>
          <SelectValue placeholder="Pick a model" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="eliza-1">eliza-1</SelectItem>
          <SelectItem value="claude-opus-4-7">claude-opus-4-7</SelectItem>
          <SelectItem value="gpt-5.5">gpt-5.5</SelectItem>
        </SelectContent>
      </Select>
    ),
  },
  {
    name: "Separator",
    importPath: 'import { Separator } from "@elizaos/ui/components/ui/separator"',
    render: () => (
      <div style={{ width: 320 }}>
        <Text>Above</Text>
        <Separator />
        <Text>Below</Text>
      </div>
    ),
  },
  {
    name: "Skeleton",
    importPath: 'import { Skeleton } from "@elizaos/ui/components/ui/skeleton"',
    render: () => (
      <div style={{ display: "grid", gap: 6, width: 240 }}>
        <Skeleton style={{ height: 16, width: "60%" }} />
        <Skeleton style={{ height: 16, width: "90%" }} />
        <Skeleton style={{ height: 16, width: "40%" }} />
      </div>
    ),
  },
  {
    name: "Spinner",
    importPath: 'import { Spinner } from "@elizaos/ui/components/ui/spinner"',
    render: () => (
      <>
        <Spinner />
        <Spinner style={{ width: 24, height: 24 }} />
      </>
    ),
  },
  {
    name: "StatusBadge + StatusDot",
    importPath: 'import { StatusBadge, StatusDot } from "@elizaos/ui/components/ui/status-badge"',
    render: () => (
      <>
        <StatusBadge tone="success">Connected</StatusBadge>
        <StatusBadge tone="warning">Pending</StatusBadge>
        <StatusBadge tone="danger">Offline</StatusBadge>
        <StatusBadge tone="info">Cloud</StatusBadge>
        <StatusDot tone="success" />
        <StatusDot tone="danger" />
      </>
    ),
  },
  {
    name: "Switch",
    importPath: 'import { Switch } from "@elizaos/ui/components/ui/switch"',
    render: () => (
      <>
        <ControlledSwitch />
        <Switch disabled />
      </>
    ),
  },
  {
    name: "Tabs",
    importPath: 'import { Tabs, TabsList, TabsTrigger, TabsContent } from "@elizaos/ui/components/ui/tabs"',
    render: () => (
      <Tabs defaultValue="local" style={{ width: 360 }}>
        <TabsList>
          <TabsTrigger value="local">Local</TabsTrigger>
          <TabsTrigger value="cloud">Cloud</TabsTrigger>
          <TabsTrigger value="mobile">Mobile</TabsTrigger>
        </TabsList>
        <TabsContent value="local">Runs on this device.</TabsContent>
        <TabsContent value="cloud">Routed through Eliza Cloud.</TabsContent>
        <TabsContent value="mobile">iOS / Android agent.</TabsContent>
      </Tabs>
    ),
  },
  {
    name: "Textarea",
    importPath: 'import { Textarea } from "@elizaos/ui/components/ui/textarea"',
    render: () => (
      <Textarea
        placeholder="Describe your agent…"
        defaultValue="A friendly local assistant."
        style={{ width: 320 }}
      />
    ),
  },
  {
    name: "Tooltip",
    importPath: 'import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@elizaos/ui/components/ui/tooltip"',
    render: () => (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Hover me</Button>
          </TooltipTrigger>
          <TooltipContent>Connected.</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ),
  },
  {
    name: "Typography (Heading + Text)",
    importPath: 'import { Heading, Text } from "@elizaos/ui/components/ui/typography"',
    render: () => (
      <div style={{ display: "grid", gap: 6 }}>
        <Heading level="h1">Run elizaOS locally.</Heading>
        <Heading level="h2">No cloud required.</Heading>
        <Text>Install once, own your agent forever.</Text>
      </div>
    ),
  },
];
