# Brand Components

This directory contains reusable brand-specific components that implement the ElizaOS Cloud design system. These components are used throughout the landing page and can be integrated across the dashboard.

## Design System

### Colors

- **Brand Orange**: `#FF5800` (primary accent color)
- **Brand Blue**: `#0B35F1` (secondary accent)
- **Brand Background**: `#0A0A0A` (almost black)
- **Brand Surface**: `#252527` (elevated surface)
- **Brand Border**: `#E1E1E1` (light borders for corners)

### Tailwind Utilities

Custom utility classes are defined in `app/globals.css`:

- `.brand-surface` - Black/40 background with white/10 border
- `.brand-surface-hover` - Same as above with hover state
- `.brand-tab` - Tab button styling
- `.brand-tab-active` - Active tab state

### HUD Button Props

- `withCorners` - Add animated corner brackets (orange brand color)
- `hudEffect` - Enable HUD-style hover/click movement with ghost shadow
- `variant` - Button style: `primary`, `hud`, `ghost`, `outline`, `icon`, `icon-primary`
- `size` - Button size: `sm`, `md`, `lg`, `icon`

### Usage Examples

```tsx
import { BrandButton } from "@/components/brand";
import { Plus } from "lucide-react";

// Full HUD button with corners and movement
<BrandButton variant="hud" withCorners hudEffect>
  <Plus /> New Agent
</BrandButton>

// Primary button with HUD effect
<BrandButton variant="primary" hudEffect>
  Create Project
</BrandButton>

// With corners only (no movement)
<BrandButton variant="hud" withCorners>
  Static Button
</BrandButton>
```

## Components

### CornerBrackets

Decorative corner brackets used throughout the design for a HUD/sci-fi aesthetic.

```tsx
import { CornerBrackets } from "@/components/brand";

<div className="relative">
  <CornerBrackets size="md" color="#E1E1E1" variant="corners" />
  {/* Your content */}
</div>;
```

**Props:**

- `size`: `"sm" | "md" | "lg" | "xl"` (default: `"md"`)
- `color`: string (default: `"#E1E1E1"`)
- `variant`: `"corners" | "full-border"` (default: `"corners"`)
- `className`: Additional CSS classes

### BrandButton

Styled button variants matching the brand design.

```tsx
import { BrandButton } from "@/components/brand";

<BrandButton variant="primary">Get Started</BrandButton>
<BrandButton variant="ghost">Cancel</BrandButton>
<BrandButton variant="outline">Learn More</BrandButton>
<BrandButton variant="icon"><Icon /></BrandButton>
<BrandButton variant="icon-primary"><Icon /></BrandButton>
```

**Variants:**

- `primary` - Orange background button
- `ghost` - Transparent with subtle hover
- `outline` - Bordered button
- `icon` - Icon-only button with border
- `icon-primary` - Icon-only with orange accent

**Sizes:** `sm`, `md`, `lg`, `icon`

### BrandTabs

Tab system with border-based active state.

```tsx
import {
  BrandTabs,
  BrandTabsList,
  BrandTabsTrigger,
  BrandTabsContent,
} from "@/components/brand";

<BrandTabs defaultValue="tab1">
  <BrandTabsList>
    <BrandTabsTrigger value="tab1">Tab 1</BrandTabsTrigger>
    <BrandTabsTrigger value="tab2">Tab 2</BrandTabsTrigger>
  </BrandTabsList>
  <BrandTabsContent value="tab1">Content 1</BrandTabsContent>
  <BrandTabsContent value="tab2">Content 2</BrandTabsContent>
</BrandTabs>;
```

**SimpleBrandTabs** - For simple category filters:

```tsx
import { SimpleBrandTabs } from "@/components/brand";

<SimpleBrandTabs
  tabs={["All", "Marketing", "Writing"]}
  activeTab={activeTab}
  onTabChange={setActiveTab}
/>;
```

### SectionHeader

Consistent section headers with orange dot indicator.

```tsx
import { SectionHeader, SectionLabel } from "@/components/brand";

<SectionHeader
  label="PRE-BUILT AGENTS"
  title="Start with Expert Templates"
  description="Launch faster with our curated collection"
  align="center"
/>

// Or just the label:
<SectionLabel>SMART, CONNECTED INTELLIGENCE</SectionLabel>
```

**Props:**

- `label`: string (required)
- `title`: string | ReactNode (optional)
- `description`: string | ReactNode (optional)
- `align`: `"left" | "center" | "right"` (default: `"left"`)
- `className`, `labelClassName`, `titleClassName`, `descriptionClassName`

### HUDContainer

Container with HUD-style corner decorations, ideal for input areas.

```tsx
import { HUDContainer } from "@/components/brand";

<HUDContainer cornerSize="md">
  <textarea placeholder="Enter text..." />
</HUDContainer>;
```

**Props:**

- `cornerSize`: `"sm" | "md" | "lg" | "xl"`
- `cornerColor`: string (default: `"#E1E1E1"`)
- `withBorder`: boolean (default: `true`)
- `className`: Additional CSS classes

### BrandCard

Reusable card component with optional corner decorations.

```tsx
import { BrandCard, AgentCard } from "@/components/brand";

<BrandCard hover corners>
  <h3>Card Title</h3>
  <p>Card content</p>
</BrandCard>

// Agent card variant:
<AgentCard
  title="Social Media Manager"
  description="Automate your social media"
  icon={<BotIcon />}
  color="#3b82f6"
  action={<button>Use Template</button>}
/>
```

**BrandCard Props:**

- `hover`: boolean - Enable hover effect
- `corners`: boolean - Show corner decorations (default: `true`)
- `cornerSize`, `cornerColor`: Corner decoration options
- `className`: Additional CSS classes

**AgentCard Props:**

- `title`, `description`, `icon`, `color`: Required
- `action`: ReactNode (optional)
- `className`: Additional CSS classes

### PromptCard

Interactive prompt suggestion cards.

```tsx
import { PromptCard, PromptCardGrid } from "@/components/brand";

// Single card:
<PromptCard
  prompt="Create an agent to manage social media"
  onClick={() => console.log("clicked")}
/>

// Grid of cards:
<PromptCardGrid
  prompts={[
    "Prompt 1",
    "Prompt 2",
    "Prompt 3",
  ]}
  onPromptClick={(prompt) => console.log(prompt)}
/>
```

## Usage Examples

### Landing Page Pattern

```tsx
import { SectionHeader, BrandCard, CornerBrackets } from "@/components/brand";

function MySection() {
  return (
    <section className="py-20 bg-[#0A0A0A] relative">
      <CornerBrackets size="xl" variant="full-border" className="m-8" />

      <div className="container">
        <SectionHeader
          label="SECTION LABEL"
          title="Section Title"
          description="Section description"
          align="center"
        />

        <BrandCard hover>
          <p>Card content</p>
        </BrandCard>
      </div>
    </section>
  );
}
```

### HUD Input Pattern

```tsx
import { HUDContainer, BrandButton, PromptCardGrid } from "@/components/brand";
import { Paperclip, Mic, ArrowUp } from "lucide-react";

function InputSection() {
  return (
    <div>
      <HUDContainer>
        <textarea placeholder="Enter prompt..." />
        <div className="absolute bottom-4 right-4 flex gap-2">
          <BrandButton variant="icon">
            <Paperclip />
          </BrandButton>
          <BrandButton variant="icon">
            <Mic />
          </BrandButton>
          <BrandButton variant="icon-primary">
            <ArrowUp style={{ color: "#FF5800" }} />
          </BrandButton>
        </div>
      </HUDContainer>

      <PromptCardGrid prompts={["Example 1", "Example 2", "Example 3"]} />
    </div>
  );
}
```

## Integration with Dashboard

All these components can be used throughout the dashboard to maintain consistent styling:

1. **Use `BrandButton` instead of regular Button** for primary actions
2. **Use `BrandTabs` for tabbed interfaces** to match landing page style
3. **Use `SectionHeader`** for consistent section headings
4. **Use `BrandCard`** for card layouts to match the landing aesthetic
5. **Use custom Tailwind utilities** (`.brand-surface`, `.brand-tab`, etc.) for quick styling

## Migration Notes

The landing page components have been updated to use these reusable components. When updating dashboard pages:

1. Import brand components: `import { ComponentName } from "@/components/brand"`
2. Replace inline styles with brand components
3. Use Tailwind color tokens: `bg-[#0A0A0A]`, `text-white/70`, etc.
4. Add corner brackets to major sections for visual consistency
5. Use the orange dot (`#FF5800`) for accent indicators
