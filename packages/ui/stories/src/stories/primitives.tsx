/**
 * Story group exercising the base UI primitives (accordion, inputs, tabs, …).
 */
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@ui-src/components/ui/accordion.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@ui-src/components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@ui-src/components/ui/alert-dialog.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@ui-src/components/ui/avatar.tsx";
import { Badge } from "@ui-src/components/ui/badge.tsx";
import { Banner } from "@ui-src/components/ui/banner.tsx";
import { Button } from "@ui-src/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@ui-src/components/ui/card.tsx";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@ui-src/components/ui/carousel.tsx";
import { Checkbox } from "@ui-src/components/ui/checkbox.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@ui-src/components/ui/collapsible.tsx";
import { CopyButton } from "@ui-src/components/ui/copy-button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ui-src/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui-src/components/ui/dropdown-menu.tsx";
import { EmptyState } from "@ui-src/components/ui/empty-state.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@ui-src/components/ui/hover-card.tsx";
import { Input } from "@ui-src/components/ui/input.tsx";
import { Label } from "@ui-src/components/ui/label.tsx";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@ui-src/components/ui/pagination.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@ui-src/components/ui/popover.tsx";
import { Progress } from "@ui-src/components/ui/progress.tsx";
import { ScrollArea } from "@ui-src/components/ui/scroll-area.tsx";
import { SegmentedControl } from "@ui-src/components/ui/segmented-control.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-src/components/ui/select.tsx";
import { Separator } from "@ui-src/components/ui/separator.tsx";
import { Skeleton } from "@ui-src/components/ui/skeleton.tsx";
import { Slider } from "@ui-src/components/ui/slider.tsx";
import { Spinner } from "@ui-src/components/ui/spinner.tsx";
import { StatusBadge, StatusDot } from "@ui-src/components/ui/status-badge.tsx";
import { Switch } from "@ui-src/components/ui/switch.tsx";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ui-src/components/ui/table.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@ui-src/components/ui/tabs.tsx";
import { TagEditor } from "@ui-src/components/ui/tag-editor.tsx";
import { Textarea } from "@ui-src/components/ui/textarea.tsx";
import { Toggle } from "@ui-src/components/ui/toggle.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@ui-src/components/ui/tooltip.tsx";
import { Heading, Text } from "@ui-src/components/ui/typography.tsx";
import {
  AlertTriangle,
  Bell,
  Bold,
  Bot,
  Check,
  ChevronRight,
  Cloud,
  Cpu,
  Inbox,
  Italic,
  Search,
  Settings,
  Trash2,
  Underline,
} from "lucide-react";
import { useState } from "react";
import type { StoryDefinition } from "../Story.tsx";

/* ---------------------------------------------------------------------------
 * Local controlled-state wrappers so each tile keeps its own instance.
 * ------------------------------------------------------------------------ */
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

function ControlledSegmented() {
  const [value, setValue] = useState<"local" | "cloud" | "mobile">("local");
  return (
    <SegmentedControl
      value={value}
      onValueChange={setValue}
      items={[
        { value: "local", label: "Local" },
        { value: "cloud", label: "Cloud" },
        { value: "mobile", label: "Mobile" },
      ]}
    />
  );
}

function ControlledTagEditor() {
  const [tags, setTags] = useState<string[]>(["local", "cloud"]);
  return (
    <TagEditor
      items={tags}
      onChange={setTags}
      label="Tags"
      placeholder="Add a tag..."
    />
  );
}

function ControlledPagination() {
  const [page, setPage] = useState(2);
  const pages = [1, 2, 3];
  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setPage((p) => Math.max(1, p - 1));
            }}
          />
        </PaginationItem>
        {pages.map((p) => (
          <PaginationItem key={p}>
            <PaginationLink
              href="#"
              isActive={p === page}
              onClick={(e) => {
                e.preventDefault();
                setPage(p);
              }}
            >
              {p}
            </PaginationLink>
          </PaginationItem>
        ))}
        <PaginationItem>
          <PaginationEllipsis />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setPage((p) => p + 1);
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

function ControlledSlider() {
  const [value, setValue] = useState<number[]>([42]);
  return (
    <Slider
      value={value}
      onValueChange={setValue}
      max={100}
      step={1}
      style={{ width: 220 }}
    />
  );
}

const scrollAreaEvents = Array.from({ length: 14 }, (_, i) => ({
  id: `event-${i + 1}`,
  label: `Event #${i + 1}`,
}));

const miniChartData = [
  { day: "Mon", tokens: 1320 },
  { day: "Tue", tokens: 1480 },
  { day: "Wed", tokens: 1210 },
  { day: "Thu", tokens: 1760 },
  { day: "Fri", tokens: 1650 },
];

function MiniChart() {
  return (
    <div
      aria-label="Local inference throughput chart"
      role="img"
      style={{
        alignItems: "end",
        border: "1px solid var(--border)",
        borderRadius: 8,
        display: "flex",
        gap: 10,
        height: 180,
        padding: 16,
        width: 320,
      }}
    >
      {miniChartData.map((point) => (
        <div
          key={point.day}
          style={{
            alignItems: "center",
            display: "flex",
            flex: 1,
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              background: "var(--accent-primary)",
              borderRadius: 4,
              height: `${Math.round(point.tokens / 18)}px`,
              width: "100%",
            }}
          />
          <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
            {point.day}
          </span>
        </div>
      ))}
    </div>
  );
}

export const primitiveStories: StoryDefinition[] = [
  {
    id: "p-accordion",
    name: "Accordion",
    importPath:
      'import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@elizaos/ui/components/ui/accordion"',
    render: () => (
      <Accordion type="single" collapsible style={{ width: "100%" }}>
        <AccordionItem value="a">
          <AccordionTrigger>What is elizaOS?</AccordionTrigger>
          <AccordionContent>The agentic operating system.</AccordionContent>
        </AccordionItem>
        <AccordionItem value="b">
          <AccordionTrigger>Do I need the cloud?</AccordionTrigger>
          <AccordionContent>No. Local-first by default.</AccordionContent>
        </AccordionItem>
      </Accordion>
    ),
  },
  {
    id: "p-alert",
    name: "Alert",
    importPath:
      'import { Alert, AlertTitle, AlertDescription } from "@elizaos/ui/components/ui/alert"',
    render: () => (
      <div className="gallery-stack">
        <Alert>
          <AlertTitle>Connected.</AlertTitle>
          <AlertDescription>Your local agent is online.</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Inference failed</AlertTitle>
          <AlertDescription>Model eliza-1 is not downloaded.</AlertDescription>
        </Alert>
      </div>
    ),
  },
  {
    id: "p-alert-dialog",
    name: "AlertDialog",
    importPath:
      'import { AlertDialog, AlertDialogTrigger, AlertDialogContent, ... } from "@elizaos/ui/components/ui/alert-dialog"',
    description: "Destructive confirmation. Click trigger to preview.",
    render: () => (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive">
            <Trash2 /> Delete agent
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the agent and all local state. Cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  },
  {
    id: "p-avatar",
    name: "Avatar",
    importPath:
      'import { Avatar, AvatarImage, AvatarFallback } from "@elizaos/ui/components/ui/avatar"',
    render: () => (
      <>
        <Avatar>
          <AvatarImage src="/brand/logos/logo_orange_nobg.svg" alt="" />
          <AvatarFallback>EZ</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>E1</AvatarFallback>
        </Avatar>
        <Avatar style={{ width: 48, height: 48 }}>
          <AvatarFallback>OS</AvatarFallback>
        </Avatar>
      </>
    ),
  },
  {
    id: "p-badge",
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
    id: "p-button",
    name: "Button",
    importPath: 'import { Button } from "@elizaos/ui/components/ui/button"',
    description: "All variants and sizes including disabled.",
    render: () => (
      <div className="gallery-stack">
        <div className="gallery-row">
          <Button>Run in Cloud</Button>
          <Button variant="secondary">Install elizaOS</Button>
          <Button variant="outline">Open Workspace</Button>
          <Button variant="ghost">Cancel</Button>
        </div>
        <div className="gallery-row">
          <Button variant="destructive">Delete agent</Button>
          <Button variant="link">Docs</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="gallery-row">
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="settings">
            <Settings />
          </Button>
        </div>
      </div>
    ),
  },
  {
    id: "p-card",
    name: "Card",
    importPath:
      'import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@elizaos/ui/components/ui/card"',
    render: () => (
      <Card style={{ maxWidth: 320, width: "100%" }}>
        <CardHeader>
          <CardTitle>Eliza Cloud</CardTitle>
          <CardDescription>
            Managed inference, billing, and deploys.
          </CardDescription>
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
    id: "p-carousel",
    name: "Carousel",
    importPath:
      'import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@elizaos/ui/components/ui/carousel"',
    render: () => (
      <Carousel style={{ width: 280 }}>
        <CarouselContent>
          {["eliza-1", "claude-opus-4-7", "gpt-5.5"].map((m) => (
            <CarouselItem key={m}>
              <Card>
                <CardHeader>
                  <CardTitle>{m}</CardTitle>
                  <CardDescription>Available now.</CardDescription>
                </CardHeader>
              </Card>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    ),
  },
  {
    id: "p-chart",
    name: "Chart",
    importPath:
      'import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@elizaos/ui/components/ui/chart"',
    description: "Local inference throughput, last 5 days (illustrative).",
    render: () => <MiniChart />,
  },
  {
    id: "p-checkbox",
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
    id: "p-dialog",
    name: "Dialog",
    importPath:
      'import { Dialog, DialogTrigger, DialogContent, ... } from "@elizaos/ui/components/ui/dialog"',
    render: () => (
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Open dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm deploy</DialogTitle>
            <DialogDescription>
              This will publish your agent to Eliza Cloud.
            </DialogDescription>
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
    id: "p-dropdown",
    name: "DropdownMenu",
    importPath:
      'import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@elizaos/ui/components/ui/dropdown-menu"',
    render: () => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <Bot /> Agents <ChevronRight />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Local</DropdownMenuLabel>
          <DropdownMenuItem>
            <Cpu /> eliza-1
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Cloud</DropdownMenuLabel>
          <DropdownMenuItem>
            <Cloud /> claude-opus-4-7
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Cloud /> gpt-5.5
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  {
    id: "p-hover-card",
    name: "HoverCard",
    importPath:
      'import { HoverCard, HoverCardTrigger, HoverCardContent } from "@elizaos/ui/components/ui/hover-card"',
    render: () => (
      <HoverCard>
        <HoverCardTrigger asChild>
          <Button variant="link">@elizaos</Button>
        </HoverCardTrigger>
        <HoverCardContent>
          <strong>elizaOS</strong>
          <p style={{ margin: "4px 0 0", fontSize: 13 }}>
            agentic operating system
          </p>
        </HoverCardContent>
      </HoverCard>
    ),
  },
  {
    id: "p-input",
    name: "Input + Label",
    importPath: 'import { Input } from "@elizaos/ui/components/ui/input"',
    render: () => (
      <div className="gallery-stack" style={{ maxWidth: 260 }}>
        <Label htmlFor="agent-name">Agent name</Label>
        <Input id="agent-name" placeholder="eliza-1" defaultValue="" />
        <Input placeholder="disabled" disabled />
      </div>
    ),
  },
  {
    id: "p-popover",
    name: "Popover",
    importPath:
      'import { Popover, PopoverTrigger, PopoverContent } from "@elizaos/ui/components/ui/popover"',
    render: () => (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">
            <Bell /> Notifications
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <strong>3 new</strong>
          <p style={{ margin: "4px 0 0", fontSize: 13 }}>
            Deploy finished. Agent connected. Token quota refilled.
          </p>
        </PopoverContent>
      </Popover>
    ),
  },
  {
    id: "p-progress",
    name: "Progress",
    importPath: 'import { Progress } from "@elizaos/ui/components/ui/progress"',
    render: () => (
      <div className="gallery-stack" style={{ width: 240 }}>
        <Progress value={20} />
        <Progress value={62} />
        <Progress value={100} />
      </div>
    ),
  },
  {
    id: "p-scroll-area",
    name: "ScrollArea",
    importPath:
      'import { ScrollArea } from "@elizaos/ui/components/ui/scroll-area"',
    render: () => (
      <ScrollArea
        style={{
          height: 140,
          width: 240,
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 2,
          padding: 12,
        }}
      >
        <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
          {scrollAreaEvents.map((event) => (
            <div key={event.id}>
              <Check style={{ display: "inline", marginRight: 6 }} />
              {event.label}
            </div>
          ))}
        </div>
      </ScrollArea>
    ),
  },
  {
    id: "p-select",
    name: "Select",
    importPath:
      'import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@elizaos/ui/components/ui/select"',
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
    id: "p-separator",
    name: "Separator",
    importPath:
      'import { Separator } from "@elizaos/ui/components/ui/separator"',
    render: () => (
      <div style={{ width: 280 }}>
        <Text>Above</Text>
        <Separator />
        <Text>Below</Text>
      </div>
    ),
  },
  {
    id: "p-skeleton",
    name: "Skeleton",
    importPath: 'import { Skeleton } from "@elizaos/ui/components/ui/skeleton"',
    render: () => (
      <div className="gallery-stack" style={{ width: 220 }}>
        <Skeleton style={{ height: 16, width: "60%" }} />
        <Skeleton style={{ height: 16, width: "90%" }} />
        <Skeleton style={{ height: 16, width: "40%" }} />
      </div>
    ),
  },
  {
    id: "p-slider",
    name: "Slider",
    importPath: 'import { Slider } from "@elizaos/ui/components/ui/slider"',
    render: () => <ControlledSlider />,
  },
  {
    id: "p-spinner",
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
    id: "p-status-badge",
    name: "StatusBadge + StatusDot",
    importPath:
      'import { StatusBadge, StatusDot } from "@elizaos/ui/components/ui/status-badge"',
    render: () => (
      <>
        <StatusBadge label="Connected" tone="success" />
        <StatusBadge label="Pending" tone="warning" />
        <StatusBadge label="Offline" tone="danger" />
        <StatusBadge label="Cloud" tone="info" />
        <StatusDot tone="success" />
        <StatusDot tone="danger" />
      </>
    ),
  },
  {
    id: "p-switch",
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
    id: "p-tabs",
    name: "Tabs",
    importPath:
      'import { Tabs, TabsList, TabsTrigger, TabsContent } from "@elizaos/ui/components/ui/tabs"',
    render: () => (
      <Tabs defaultValue="local" style={{ width: 320 }}>
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
    id: "p-textarea",
    name: "Textarea",
    importPath: 'import { Textarea } from "@elizaos/ui/components/ui/textarea"',
    render: () => (
      <Textarea
        placeholder="Describe your agent…"
        defaultValue="A friendly local assistant."
        style={{ width: 280 }}
      />
    ),
  },
  {
    id: "p-tooltip",
    name: "Tooltip",
    importPath:
      'import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@elizaos/ui/components/ui/tooltip"',
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
    id: "p-banner",
    name: "Banner",
    importPath: 'import { Banner } from "@elizaos/ui/components/ui/banner"',
    render: () => (
      <div className="gallery-stack">
        <Banner variant="info">Local inference is online.</Banner>
        <Banner variant="warning" dismissible>
          Cloud quota near limit.
        </Banner>
        <Banner variant="error" action={<Button size="sm">Retry</Button>}>
          Failed to load eliza-1.
        </Banner>
      </div>
    ),
  },
  {
    id: "p-collapsible",
    name: "Collapsible",
    importPath:
      'import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@elizaos/ui/components/ui/collapsible"',
    render: () => (
      <Collapsible style={{ width: 240 }}>
        <CollapsibleTrigger asChild>
          <Button variant="outline">Toggle details</Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div style={{ paddingTop: 8, fontSize: 13 }}>
            Local-first by default. No cloud required.
          </div>
        </CollapsibleContent>
      </Collapsible>
    ),
  },
  {
    id: "p-copy-button",
    name: "CopyButton",
    importPath:
      'import { CopyButton } from "@elizaos/ui/components/ui/copy-button"',
    render: () => (
      <div className="gallery-row">
        <CopyButton value="bun install @elizaos/ui" />
        <CopyButton value="claude-opus-4-7" copyLabel="Copy model" />
      </div>
    ),
  },
  {
    id: "p-empty-state",
    name: "EmptyState",
    importPath:
      'import { EmptyState } from "@elizaos/ui/components/ui/empty-state"',
    render: () => (
      <div style={{ width: "100%" }}>
        <EmptyState
          variant="dashed"
          icon={<Inbox />}
          title="No agents yet"
          description="Spawn your first local agent to get started."
          action={<Button size="sm">Create agent</Button>}
        />
      </div>
    ),
  },
  {
    id: "p-pagination",
    name: "Pagination",
    importPath:
      'import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious, PaginationEllipsis } from "@elizaos/ui/components/ui/pagination"',
    render: () => <ControlledPagination />,
  },
  {
    id: "p-segmented-control",
    name: "SegmentedControl",
    importPath:
      'import { SegmentedControl } from "@elizaos/ui/components/ui/segmented-control"',
    render: () => <ControlledSegmented />,
  },
  {
    id: "p-table",
    name: "Table",
    importPath:
      'import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption } from "@elizaos/ui/components/ui/table"',
    render: () => (
      <Table style={{ width: 360 }}>
        <TableCaption>Active local models.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Tok/s</TableHead>
            <TableHead>State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>eliza-1</TableCell>
            <TableCell>1.2k</TableCell>
            <TableCell>ready</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>claude-opus-4-7</TableCell>
            <TableCell>—</TableCell>
            <TableCell>cloud</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    ),
  },
  {
    id: "p-tag-editor",
    name: "TagEditor",
    importPath:
      'import { TagEditor } from "@elizaos/ui/components/ui/tag-editor"',
    render: () => (
      <div style={{ width: 280 }}>
        <ControlledTagEditor />
      </div>
    ),
  },
  {
    id: "p-toggle",
    name: "Toggle",
    importPath: 'import { Toggle } from "@elizaos/ui/components/ui/toggle"',
    render: () => (
      <div className="gallery-row">
        <Toggle aria-label="Bold">
          <Bold />
        </Toggle>
        <Toggle aria-label="Italic" defaultPressed>
          <Italic />
        </Toggle>
        <Toggle aria-label="Underline">
          <Underline />
        </Toggle>
      </div>
    ),
  },
  {
    id: "p-typography",
    name: "Typography (Heading + Text)",
    importPath:
      'import { Heading, Text } from "@elizaos/ui/components/ui/typography"',
    render: () => (
      <div className="gallery-stack">
        <Heading level="h1">Run elizaOS locally.</Heading>
        <Heading level="h2">No cloud required.</Heading>
        <Text>Install once, own your agent forever.</Text>
      </div>
    ),
  },
];
