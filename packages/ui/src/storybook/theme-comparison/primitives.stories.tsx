/**
 * Story group exercising the base UI primitives (accordion, inputs, tabs, …).
 */

import type { Meta, StoryObj } from "@storybook/react";
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
  Settings,
  Trash2,
  Underline,
} from "lucide-react";
import { useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../components/ui/accordion.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
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
} from "../../components/ui/alert-dialog.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "../../components/ui/avatar.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Banner } from "../../components/ui/banner.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "../../components/ui/carousel.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible.tsx";
import { CopyButton } from "../../components/ui/copy-button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { EmptyState } from "../../components/ui/empty-state.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../../components/ui/hover-card.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../../components/ui/pagination.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { ScrollArea } from "../../components/ui/scroll-area.tsx";
import { SegmentedControl } from "../../components/ui/segmented-control.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import { Separator } from "../../components/ui/separator.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Slider } from "../../components/ui/slider.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { StatusBadge, StatusDot } from "../../components/ui/status-badge.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs.tsx";
import { TagEditor } from "../../components/ui/tag-editor.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { Toggle } from "../../components/ui/toggle.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.tsx";
import { Heading, Text } from "../../components/ui/typography.tsx";
import { ThemeComparison } from "./ThemeComparison";

/* ---------------------------------------------------------------------------
 * Local controlled-state wrappers so each tile keeps its own instance.
 * ------------------------------------------------------------------------ */
function ControlledSwitch() {
  const [on, setOn] = useState(true);
  return (
    <Switch aria-label="Notifications" checked={on} onCheckedChange={setOn} />
  );
}

function ControlledCheckbox() {
  const [on, setOn] = useState(true);
  return (
    <Checkbox
      aria-label="Enable local inference"
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
      aria-label="Volume"
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

export default {
  title: "Comparisons/Primitives",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export const PAccordion: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-accordion",
        name: "Accordion",
        importPath:
          'import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PAlert: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-alert",
        name: "Alert",
        importPath:
          'import { Alert, AlertTitle, AlertDescription } from "@elizaos/ui"',
        render: () => (
          <div className="gallery-stack">
            <Alert>
              <AlertTitle>Connected.</AlertTitle>
              <AlertDescription>Your local agent is online.</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Inference failed</AlertTitle>
              <AlertDescription>
                Model eliza-1 is not downloaded.
              </AlertDescription>
            </Alert>
          </div>
        ),
      }}
    />
  ),
};

export const PAlertDialog: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-alert-dialog",
        name: "AlertDialog",
        importPath:
          'import { AlertDialog, AlertDialogTrigger, AlertDialogContent, ... } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PAvatar: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-avatar",
        name: "Avatar",
        importPath:
          'import { Avatar, AvatarImage, AvatarFallback } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PBadge: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-badge",
        name: "Badge",
        importPath: 'import { Badge } from "@elizaos/ui"',
        render: () => (
          <>
            <Badge>Default</Badge>
            <Badge variant="secondary">Local</Badge>
            <Badge variant="outline">Optional</Badge>
            <Badge variant="destructive">Failed</Badge>
          </>
        ),
      }}
    />
  ),
};

export const PButton: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-button",
        name: "Button",
        importPath: 'import { Button } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PCard: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-card",
        name: "Card",
        importPath:
          'import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PCarousel: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-carousel",
        name: "Carousel",
        importPath:
          'import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PChart: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-chart",
        name: "Chart",
        importPath:
          'import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@elizaos/ui"',
        description: "Local inference throughput, last 5 days (illustrative).",
        render: () => <MiniChart />,
      }}
    />
  ),
};

export const PCheckbox: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-checkbox",
        name: "Checkbox",
        importPath: 'import { Checkbox } from "@elizaos/ui"',
        render: () => (
          <>
            <ControlledCheckbox />
            <Checkbox aria-label="Unavailable option" disabled />
          </>
        ),
      }}
    />
  ),
};

export const PDialog: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-dialog",
        name: "Dialog",
        importPath:
          'import { Dialog, DialogTrigger, DialogContent, ... } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PDropdown: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-dropdown",
        name: "DropdownMenu",
        importPath:
          'import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PHoverCard: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-hover-card",
        name: "HoverCard",
        importPath:
          'import { HoverCard, HoverCardTrigger, HoverCardContent } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PInput: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-input",
        name: "Input + Label",
        importPath: 'import { Input } from "@elizaos/ui"',
        render: () => (
          <div className="gallery-stack" style={{ maxWidth: 260 }}>
            <Label htmlFor="agent-name">Agent name</Label>
            <Input id="agent-name" placeholder="eliza-1" defaultValue="" />
            <Input placeholder="disabled" disabled />
          </div>
        ),
      }}
    />
  ),
};

export const PPopover: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-popover",
        name: "Popover",
        importPath:
          'import { Popover, PopoverTrigger, PopoverContent } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PProgress: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-progress",
        name: "Progress",
        importPath: 'import { Progress } from "@elizaos/ui"',
        render: () => (
          <div className="gallery-stack" style={{ width: 240 }}>
            <Progress value={20} />
            <Progress value={62} />
            <Progress value={100} />
          </div>
        ),
      }}
    />
  ),
};

export const PScrollArea: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-scroll-area",
        name: "ScrollArea",
        importPath: 'import { ScrollArea } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PSelect: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-select",
        name: "Select",
        importPath:
          'import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@elizaos/ui"',
        render: () => (
          <Select defaultValue="eliza-1">
            <SelectTrigger aria-label="Model" style={{ width: 200 }}>
              <SelectValue placeholder="Pick a model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eliza-1">eliza-1</SelectItem>
              <SelectItem value="claude-opus-4-7">claude-opus-4-7</SelectItem>
              <SelectItem value="gpt-5.5">gpt-5.5</SelectItem>
            </SelectContent>
          </Select>
        ),
      }}
    />
  ),
};

export const PSeparator: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-separator",
        name: "Separator",
        importPath: 'import { Separator } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: 280 }}>
            <Text>Above</Text>
            <Separator />
            <Text>Below</Text>
          </div>
        ),
      }}
    />
  ),
};

export const PSkeleton: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-skeleton",
        name: "Skeleton",
        importPath: 'import { Skeleton } from "@elizaos/ui"',
        render: () => (
          <div className="gallery-stack" style={{ width: 220 }}>
            <Skeleton style={{ height: 16, width: "60%" }} />
            <Skeleton style={{ height: 16, width: "90%" }} />
            <Skeleton style={{ height: 16, width: "40%" }} />
          </div>
        ),
      }}
    />
  ),
};

export const PSlider: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-slider",
        name: "Slider",
        importPath: 'import { Slider } from "@elizaos/ui"',
        render: () => <ControlledSlider />,
      }}
    />
  ),
};

export const PSpinner: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-spinner",
        name: "Spinner",
        importPath: 'import { Spinner } from "@elizaos/ui"',
        render: () => (
          <>
            <Spinner />
            <Spinner style={{ width: 24, height: 24 }} />
          </>
        ),
      }}
    />
  ),
};

export const PStatusBadge: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-status-badge",
        name: "StatusBadge + StatusDot",
        importPath: 'import { StatusBadge, StatusDot } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PSwitch: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-switch",
        name: "Switch",
        importPath: 'import { Switch } from "@elizaos/ui"',
        render: () => (
          <>
            <ControlledSwitch />
            <Switch aria-label="Unavailable notifications" disabled />
          </>
        ),
      }}
    />
  ),
};

export const PTabs: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-tabs",
        name: "Tabs",
        importPath:
          'import { Tabs, TabsList, TabsTrigger, TabsContent } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PTextarea: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-textarea",
        name: "Textarea",
        importPath: 'import { Textarea } from "@elizaos/ui"',
        render: () => (
          <Textarea
            placeholder="Describe your agent…"
            defaultValue="A friendly local assistant."
            style={{ width: 280 }}
          />
        ),
      }}
    />
  ),
};

export const PTooltip: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-tooltip",
        name: "Tooltip",
        importPath:
          'import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PBanner: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-banner",
        name: "Banner",
        importPath: 'import { Banner } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PCollapsible: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-collapsible",
        name: "Collapsible",
        importPath:
          'import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PCopyButton: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-copy-button",
        name: "CopyButton",
        importPath: 'import { CopyButton } from "@elizaos/ui"',
        render: () => (
          <div className="gallery-row">
            <CopyButton value="bun install @elizaos/ui" />
            <CopyButton value="claude-opus-4-7" copyLabel="Copy model" />
          </div>
        ),
      }}
    />
  ),
};

export const PEmptyState: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-empty-state",
        name: "EmptyState",
        importPath: 'import { EmptyState } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PPagination: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-pagination",
        name: "Pagination",
        importPath:
          'import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious, PaginationEllipsis } from "@elizaos/ui"',
        render: () => <ControlledPagination />,
      }}
    />
  ),
};

export const PSegmentedControl: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-segmented-control",
        name: "SegmentedControl",
        importPath: 'import { SegmentedControl } from "@elizaos/ui"',
        render: () => <ControlledSegmented />,
      }}
    />
  ),
};

export const PTable: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-table",
        name: "Table",
        importPath:
          'import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PTagEditor: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-tag-editor",
        name: "TagEditor",
        importPath: 'import { TagEditor } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: 280 }}>
            <ControlledTagEditor />
          </div>
        ),
      }}
    />
  ),
};

export const PToggle: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-toggle",
        name: "Toggle",
        importPath: 'import { Toggle } from "@elizaos/ui"',
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
      }}
    />
  ),
};

export const PTypography: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "p-typography",
        name: "Typography (Heading + Text)",
        importPath: 'import { Heading, Text } from "@elizaos/ui"',
        render: () => (
          <div className="gallery-stack">
            <Heading level="h1">Run elizaOS locally.</Heading>
            <Heading level="h2">No cloud required.</Heading>
            <Text>Install once, own your agent forever.</Text>
          </div>
        ),
      }}
    />
  ),
};
